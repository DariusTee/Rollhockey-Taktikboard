"use strict";

const crypto = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { createPasswordRecord, randomCode, verifyPassword } = require("./passwords");

initializeApp();
setGlobalOptions({ region: "europe-west1", maxInstances: 20 });

const db = getFirestore();
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const BLOCK_DURATION_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function requireUser(request) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Eine Anmeldung ist erforderlich.");
  return uid;
}

function cleanText(value, field, maxLength, required = false) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new HttpsError("invalid-argument", `${field} fehlt.`);
  if (text.length > maxLength) throw new HttpsError("invalid-argument", `${field} ist zu lang.`);
  return text;
}

function validatePassword(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new HttpsError("invalid-argument", "Das Passwort muss 8 bis 128 Zeichen lang sein.");
  }
  return value.normalize("NFKC");
}

async function passwordRecord(password) {
  return createPasswordRecord(validatePassword(password), FieldValue.serverTimestamp());
}

async function getTeamAndRole(teamId, uid) {
  const safeTeamId = cleanText(teamId, "Team-ID", 128, true);
  const teamRef = db.collection("teams").doc(safeTeamId);
  const memberRef = teamRef.collection("members").doc(uid);
  const [teamSnapshot, memberSnapshot] = await Promise.all([teamRef.get(), memberRef.get()]);
  if (!teamSnapshot.exists) throw new HttpsError("not-found", "Team nicht gefunden.");
  const team = teamSnapshot.data();
  const role = team.ownerId === uid ? "admin" : memberSnapshot.data()?.role || null;
  return { teamRef, team, role, memberRef };
}

async function requireAdmin(teamId, uid) {
  const result = await getTeamAndRole(teamId, uid);
  if (result.role !== "admin") throw new HttpsError("permission-denied", "Administratorrechte erforderlich.");
  return result;
}

function rateLimitId(request, code, uid) {
  const ip = request.rawRequest?.ip || request.rawRequest?.headers?.["x-forwarded-for"] || "unknown";
  return crypto.createHash("sha256").update(`${uid}:${code}:${ip}`).digest("hex");
}

async function registerFailedAttempt(ref) {
  const now = Date.now();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.data() || {};
    const windowStarted = current.windowStartedAt?.toMillis?.() || 0;
    const inWindow = now - windowStarted < ATTEMPT_WINDOW_MS;
    const attempts = (inWindow ? Number(current.attempts || 0) : 0) + 1;
    const blockedUntil = attempts >= MAX_ATTEMPTS ? Timestamp.fromMillis(now + BLOCK_DURATION_MS) : null;
    transaction.set(ref, {
      attempts,
      windowStartedAt: Timestamp.fromMillis(inWindow ? windowStarted : now),
      blockedUntil,
      expiresAt: Timestamp.fromMillis(now + 24 * 60 * 60 * 1000)
    });
    return { attempts, blockedUntil };
  });
}

exports.createTeam = onCall(async (request) => {
  const uid = requireUser(request);
  const name = cleanText(request.data?.name, "Teamname", 80, true);
  const description = cleanText(request.data?.description, "Beschreibung", 500);
  const isPrivate = request.data?.isPrivate === true;
  const secret = isPrivate ? await passwordRecord(request.data?.password) : null;
  const teamRef = db.collection("teams").doc();
  const inviteCode = randomCode();
  const codeRef = db.collection("teamCodes").doc(inviteCode);

  await db.runTransaction(async (transaction) => {
    const existingCode = await transaction.get(codeRef);
    if (existingCode.exists) throw new HttpsError("aborted", "Bitte erneut versuchen.");
    const now = FieldValue.serverTimestamp();
    transaction.create(teamRef, {
      name,
      description,
      ownerId: uid,
      isPrivate,
      inviteCode,
      createdAt: now,
      updatedAt: now
    });
    transaction.create(teamRef.collection("members").doc(uid), { role: "admin", joinedAt: now });
    transaction.set(db.collection("users").doc(uid).collection("teams").doc(teamRef.id), { role: "admin", joinedAt: now });
    transaction.create(codeRef, { teamId: teamRef.id, createdAt: now });
    if (secret) transaction.create(db.collection("teamSecrets").doc(teamRef.id), secret);
  });

  return { teamId: teamRef.id, inviteCode };
});

exports.joinTeam = onCall(async (request) => {
  const uid = requireUser(request);
  const code = cleanText(request.data?.code, "Teamcode", 32, true).toUpperCase();
  const codeSnapshot = await db.collection("teamCodes").doc(code).get();
  if (!codeSnapshot.exists) throw new HttpsError("not-found", "Team nicht gefunden.");

  const teamId = codeSnapshot.data().teamId;
  const teamRef = db.collection("teams").doc(teamId);
  const memberRef = teamRef.collection("members").doc(uid);
  const [teamSnapshot, existingMember] = await Promise.all([teamRef.get(), memberRef.get()]);
  if (!teamSnapshot.exists) throw new HttpsError("not-found", "Team nicht gefunden.");
  if (existingMember.exists) return { teamId, role: existingMember.data().role, alreadyMember: true };

  const team = teamSnapshot.data();
  const rateRef = db.collection("joinRateLimits").doc(rateLimitId(request, code, uid));
  const rateSnapshot = await rateRef.get();
  const blockedUntil = rateSnapshot.data()?.blockedUntil?.toMillis?.() || 0;
  if (blockedUntil > Date.now()) throw new HttpsError("resource-exhausted", "Zu viele Versuche.");

  if (team.isPrivate) {
    const secretSnapshot = await db.collection("teamSecrets").doc(teamId).get();
    const valid = await verifyPassword(request.data?.password, secretSnapshot.data());
    if (!valid) {
      const attempt = await registerFailedAttempt(rateRef);
      if (attempt.blockedUntil) throw new HttpsError("resource-exhausted", "Zu viele Versuche.");
      throw new HttpsError("permission-denied", "Teamcode oder Passwort ist ungültig.");
    }
  }

  const batch = db.batch();
  const now = FieldValue.serverTimestamp();
  batch.create(memberRef, { role: "player", joinedAt: now });
  batch.set(db.collection("users").doc(uid).collection("teams").doc(teamId), { role: "player", joinedAt: now });
  batch.delete(rateRef);
  await batch.commit();
  return { teamId, role: "player", alreadyMember: false };
});

exports.updateTeam = onCall(async (request) => {
  const uid = requireUser(request);
  const { teamRef, team } = await requireAdmin(request.data?.teamId, uid);
  const name = cleanText(request.data?.name, "Teamname", 80, true);
  const description = cleanText(request.data?.description, "Beschreibung", 500);
  const isPrivate = request.data?.isPrivate === true;
  let secret = null;
  if (isPrivate && !team.isPrivate) secret = await passwordRecord(request.data?.password);

  const batch = db.batch();
  batch.update(teamRef, { name, description, isPrivate, updatedAt: FieldValue.serverTimestamp() });
  const secretRef = db.collection("teamSecrets").doc(teamRef.id);
  if (secret) batch.set(secretRef, secret);
  if (!isPrivate && team.isPrivate) batch.delete(secretRef);
  await batch.commit();
  return { teamId: teamRef.id };
});

exports.changeTeamPassword = onCall(async (request) => {
  const uid = requireUser(request);
  const { teamRef, team } = await requireAdmin(request.data?.teamId, uid);
  if (!team.isPrivate) throw new HttpsError("failed-precondition", "Öffentliche Teams besitzen kein Passwort.");
  const secret = await passwordRecord(request.data?.password);
  await Promise.all([
    db.collection("teamSecrets").doc(teamRef.id).set(secret),
    teamRef.update({ updatedAt: FieldValue.serverTimestamp() })
  ]);
  return { teamId: teamRef.id };
});

exports.updateMemberRole = onCall(async (request) => {
  const uid = requireUser(request);
  const { teamRef, team } = await requireAdmin(request.data?.teamId, uid);
  const targetUid = cleanText(request.data?.userId, "Benutzer-ID", 128, true);
  const role = request.data?.role;
  if (role !== "admin" && role !== "player") throw new HttpsError("invalid-argument", "Ungültige Rolle.");
  if (targetUid === team.ownerId) throw new HttpsError("failed-precondition", "Die Besitzerrolle kann nicht geändert werden.");
  const memberRef = teamRef.collection("members").doc(targetUid);
  if (!(await memberRef.get()).exists) throw new HttpsError("not-found", "Mitglied nicht gefunden.");
  const batch = db.batch();
  batch.update(memberRef, { role, roleUpdatedAt: FieldValue.serverTimestamp(), roleUpdatedBy: uid });
  batch.set(db.collection("users").doc(targetUid).collection("teams").doc(teamRef.id), { role }, { merge: true });
  await batch.commit();
  return { teamId: teamRef.id, userId: targetUid, role };
});

exports.removeMember = onCall(async (request) => {
  const uid = requireUser(request);
  const { teamRef, team } = await requireAdmin(request.data?.teamId, uid);
  const targetUid = cleanText(request.data?.userId, "Benutzer-ID", 128, true);
  if (targetUid === team.ownerId) throw new HttpsError("failed-precondition", "Der Teambesitzer kann nicht entfernt werden.");
  const batch = db.batch();
  batch.delete(teamRef.collection("members").doc(targetUid));
  batch.delete(db.collection("users").doc(targetUid).collection("teams").doc(teamRef.id));
  await batch.commit();
  return { teamId: teamRef.id, userId: targetUid };
});

exports.copyTactic = onCall(async (request) => {
  const uid = requireUser(request);
  const sourceTeamId = cleanText(request.data?.sourceTeamId, "Quellteam", 128, true);
  const targetTeamId = cleanText(request.data?.targetTeamId, "Zielteam", 128, true);
  const tacticId = cleanText(request.data?.tacticId, "Taktik-ID", 128, true);
  const [sourceAccess, targetAccess] = await Promise.all([
    getTeamAndRole(sourceTeamId, uid),
    requireAdmin(targetTeamId, uid)
  ]);
  if (sourceAccess.team.isPrivate && !sourceAccess.role) {
    throw new HttpsError("permission-denied", "Kein Zugriff auf das Quellteam.");
  }
  const sourceSnapshot = await sourceAccess.teamRef.collection("taktiken").doc(tacticId).get();
  if (!sourceSnapshot.exists) throw new HttpsError("not-found", "Taktik nicht gefunden.");
  const source = sourceSnapshot.data();
  const created = await targetAccess.teamRef.collection("taktiken").add({
    name: `${cleanText(source.name, "Taktikname", 120) || "Unbenannte Taktik"} (Kopie)`,
    frames: source.frames || source.data?.frames || source.data,
    createdBy: uid,
    updatedBy: uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    schemaVersion: Number(source.schemaVersion || 2),
    copiedFrom: { teamId: sourceTeamId, tacticId }
  });
  return { teamId: targetTeamId, tacticId: created.id };
});

exports.migrateLegacyTactics = onCall(async (request) => {
  const uid = requireUser(request);
  const { teamRef } = await requireAdmin(request.data?.teamId, uid);
  const legacySnapshot = await db.collection("spielzuege").get();
  const candidates = legacySnapshot.docs.filter((legacy) => Array.isArray(legacy.data().frames));
  let copied = 0;
  let skipped = legacySnapshot.size - candidates.length;

  for (let offset = 0; offset < candidates.length; offset += 300) {
    const chunk = candidates.slice(offset, offset + 300);
    const targetRefs = chunk.map((legacy) => teamRef.collection("taktiken").doc(`legacy_${legacy.id}`));
    const existing = await db.getAll(...targetRefs);
    const batch = db.batch();
    chunk.forEach((legacy, index) => {
      if (existing[index].exists) {
        skipped += 1;
        return;
      }
      const source = legacy.data();
      batch.create(targetRefs[index], {
        name: cleanText(source.name, "Taktikname", 120) || "Migrierter Spielzug",
        frames: source.frames,
        createdBy: uid,
        updatedBy: uid,
        createdAt: source.erstellt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        schemaVersion: 2,
        legacySourceId: legacy.id
      });
      copied += 1;
    });
    await batch.commit();
  }
  return { teamId: teamRef.id, copied, skipped };
});

exports.deleteTeam = onCall(async (request) => {
  const uid = requireUser(request);
  const { teamRef, team } = await requireAdmin(request.data?.teamId, uid);
  if (team.ownerId !== uid) throw new HttpsError("permission-denied", "Nur der Teambesitzer darf das Team löschen.");
  await teamRef.update({ deletingAt: FieldValue.serverTimestamp() });
  const members = await teamRef.collection("members").get();

  for (let offset = 0; offset < members.docs.length; offset += 400) {
    const batch = db.batch();
    members.docs.slice(offset, offset + 400).forEach((member) => {
      batch.delete(db.collection("users").doc(member.id).collection("teams").doc(teamRef.id));
    });
    await batch.commit();
  }

  const cleanup = db.batch();
  cleanup.delete(db.collection("teamCodes").doc(team.inviteCode));
  cleanup.delete(db.collection("teamSecrets").doc(teamRef.id));
  await cleanup.commit();
  await db.recursiveDelete(teamRef);
  return { teamId: teamRef.id };
});

