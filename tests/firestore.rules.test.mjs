import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  Timestamp,
  updateDoc,
  where
} from "firebase/firestore";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rules = fs.readFileSync(path.resolve(__dirname, "..", "firestore.rules"), "utf8");
const projectId = "demo-rollhockey-taktikboard";
let env;

const publicTeam = "public-team";
const privateTeam = "private-team";
const adminUid = "trainer-1";
const playerUid = "player-1";
const outsiderUid = "outsider-1";

function tactic(uid = adminUid) {
  const createdAt = Timestamp.fromMillis(1_700_000_000_000);
  return {
    name: "Powerplay",
    frames: [{ players: [], ball: { x: 0.5, y: 0.5, visible: true }, arrows: [] }],
    createdBy: uid,
    updatedBy: uid,
    createdAt,
    updatedAt: createdAt,
    schemaVersion: 2
  };
}

async function seed() {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const createdAt = Timestamp.fromMillis(1_700_000_000_000);
    await Promise.all([
      setDoc(doc(db, "teams", publicTeam), {
        name: "Öffentlich",
        description: "",
        ownerId: adminUid,
        isPrivate: false,
        inviteCode: "PUBLIC1234",
        createdAt,
        updatedAt: createdAt
      }),
      setDoc(doc(db, "teams", privateTeam), {
        name: "Privat",
        description: "",
        ownerId: adminUid,
        isPrivate: true,
        inviteCode: "PRIVATE123",
        createdAt,
        updatedAt: createdAt
      }),
      setDoc(doc(db, "teams", publicTeam, "members", adminUid), { role: "admin", joinedAt: createdAt }),
      setDoc(doc(db, "teams", privateTeam, "members", adminUid), { role: "admin", joinedAt: createdAt }),
      setDoc(doc(db, "teams", privateTeam, "members", playerUid), { role: "player", joinedAt: createdAt }),
      setDoc(doc(db, "users", adminUid, "teams", privateTeam), { role: "admin", joinedAt: createdAt }),
      setDoc(doc(db, "users", playerUid, "teams", privateTeam), { role: "player", joinedAt: createdAt }),
      setDoc(doc(db, "teams", publicTeam, "taktiken", "public-tactic"), tactic()),
      setDoc(doc(db, "teams", privateTeam, "taktiken", "private-tactic"), tactic()),
      setDoc(doc(db, "teamSecrets", privateTeam), { hash: "server-only", salt: "server-only" }),
      setDoc(doc(db, "teamCodes", "PRIVATE123"), { teamId: privateTeam })
    ]);
  });
}

before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { rules } });
});

beforeEach(async () => {
  await env.clearFirestore();
  await seed();
});

after(async () => {
  await env.cleanup();
});

test("öffentliche Teams und Taktiken sind für angemeldete Nutzer lesbar", async () => {
  const db = env.authenticatedContext(outsiderUid).firestore();
  await assertSucceeds(getDoc(doc(db, "teams", publicTeam)));
  await assertSucceeds(getDoc(doc(db, "teams", publicTeam, "taktiken", "public-tactic")));
  await assertSucceeds(getDocs(query(collection(db, "teams"), where("isPrivate", "==", false))));
});

test("nicht angemeldete Nutzer erhalten keinen Datenzugriff", async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, "teams", publicTeam)));
  await assertFails(getDoc(doc(db, "teams", publicTeam, "taktiken", "public-tactic")));
});

test("private Teams und Taktiken sind für Außenstehende gesperrt", async () => {
  const db = env.authenticatedContext(outsiderUid).firestore();
  await assertFails(getDoc(doc(db, "teams", privateTeam)));
  await assertFails(getDoc(doc(db, "teams", privateTeam, "taktiken", "private-tactic")));
  await assertFails(getDocs(collection(db, "teams", privateTeam, "members")));
});

test("Spieler dürfen private Taktiken ansehen, aber nicht verändern", async () => {
  const db = env.authenticatedContext(playerUid).firestore();
  const tacticRef = doc(db, "teams", privateTeam, "taktiken", "private-tactic");
  await assertSucceeds(getDoc(doc(db, "teams", privateTeam)));
  await assertSucceeds(getDoc(tacticRef));
  await assertFails(updateDoc(tacticRef, { name: "Manipuliert" }));
  await assertFails(deleteDoc(tacticRef));
  await assertFails(setDoc(doc(db, "teams", privateTeam, "taktiken", "new"), tactic(playerUid)));
});

test("Trainer dürfen gültige Taktiken erstellen, bearbeiten und löschen", async () => {
  const db = env.authenticatedContext(adminUid).firestore();
  const tacticRef = doc(db, "teams", privateTeam, "taktiken", "new-tactic");
  const data = tactic();
  await assertSucceeds(setDoc(tacticRef, data));
  await assertSucceeds(updateDoc(tacticRef, {
    name: "Powerplay 2",
    frames: data.frames,
    updatedBy: adminUid,
    updatedAt: Timestamp.fromMillis(1_700_000_100_000)
  }));
  await assertSucceeds(deleteDoc(tacticRef));
});

test("Clients können weder Teams noch Rollen oder Besitzerrechte manipulieren", async () => {
  const adminDb = env.authenticatedContext(adminUid).firestore();
  const playerDb = env.authenticatedContext(playerUid).firestore();
  await assertFails(updateDoc(doc(adminDb, "teams", privateTeam), { name: "Direkt geändert" }));
  await assertFails(updateDoc(doc(playerDb, "teams", privateTeam, "members", playerUid), { role: "admin" }));
  await assertFails(setDoc(doc(playerDb, "teams", privateTeam, "members", outsiderUid), { role: "admin" }));
});

test("Mitgliedschaftsindex ist ausschließlich für den jeweiligen Nutzer lesbar", async () => {
  const playerDb = env.authenticatedContext(playerUid).firestore();
  await assertSucceeds(getDoc(doc(playerDb, "users", playerUid, "teams", privateTeam)));
  await assertFails(getDoc(doc(playerDb, "users", adminUid, "teams", privateTeam)));
  await assertFails(updateDoc(doc(playerDb, "users", playerUid, "teams", privateTeam), { role: "admin" }));
});

test("Passworthashes, Teamcodes und Rate-Limits sind für alle Clients gesperrt", async () => {
  const adminDb = env.authenticatedContext(adminUid).firestore();
  await assertFails(getDoc(doc(adminDb, "teamSecrets", privateTeam)));
  await assertFails(getDoc(doc(adminDb, "teamCodes", "PRIVATE123")));
  await assertFails(setDoc(doc(adminDb, "joinRateLimits", "attempt"), { attempts: 0 }));
});

test("alte Spielzüge bleiben lesbar, aber unveränderlich", async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "spielzuege", "legacy"), { name: "Alt", frames: [] });
  });
  const db = env.authenticatedContext(adminUid).firestore();
  await assertSucceeds(getDoc(doc(db, "spielzuege", "legacy")));
  await assertFails(deleteDoc(doc(db, "spielzuege", "legacy")));
});
