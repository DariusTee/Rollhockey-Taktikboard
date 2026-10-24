import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyCctqi6kI2PkcsZrAVjH5Bhg5ISkTBJRuo",
  authDomain: "rollhockey-taktikboard.firebaseapp.com",
  projectId: "rollhockey-taktikboard",
  storageBucket: "rollhockey-taktikboard.firebasestorage.app",
  messagingSenderId: "262790321501",
  appId: "1:262790321501:web:99dd56781fdc1dcfa344b4",
  measurementId: "G-421YS7QL31"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "europe-west1");

const call = (name) => httpsCallable(functions, name);
const api = {
  createTeam: call("createTeam"),
  joinTeam: call("joinTeam"),
  updateTeam: call("updateTeam"),
  changeTeamPassword: call("changeTeamPassword"),
  deleteTeam: call("deleteTeam"),
  updateMemberRole: call("updateMemberRole"),
  removeMember: call("removeMember"),
  copyTactic: call("copyTactic"),
  migrateLegacyTactics: call("migrateLegacyTactics")
};

const state = {
  user: null,
  teams: new Map(),
  currentTeamId: "",
  currentTacticId: "",
  currentTacticName: "",
  pendingCopyTacticId: "",
  busy: false
};

const el = (id) => document.getElementById(id);

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function makeButton(label, className, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function setBusy(value) {
  state.busy = value;
  document.querySelectorAll("#team-modal button, #team-modal input, #team-modal textarea, #team-modal select")
    .forEach((control) => {
      if (!control.classList.contains("always-enabled")) control.disabled = value;
    });
}

function notice(message, isError = false) {
  const box = el("team-notice");
  box.textContent = message;
  box.classList.toggle("error", isError);
  box.classList.add("visible");
}

function clearNotice() {
  const box = el("team-notice");
  box.textContent = "";
  box.classList.remove("visible", "error");
}

function friendlyError(error) {
  console.error(error);
  const code = String(error?.code || "").replace("functions/", "");
  const known = {
    "already-exists": "Du bist bereits Mitglied dieses Teams.",
    "failed-precondition": "Die Aktion ist für dieses Team derzeit nicht möglich.",
    "invalid-argument": "Bitte prüfe deine Eingaben.",
    "not-found": "Das Team oder die Taktik wurde nicht gefunden.",
    "permission-denied": "Dir fehlt die Berechtigung für diese Aktion.",
    "resource-exhausted": "Zu viele Versuche. Bitte warte einige Minuten.",
    "unauthenticated": "Die Anmeldung ist noch nicht abgeschlossen."
  };
  return known[code] || error?.message || "Die Aktion ist fehlgeschlagen.";
}

function roleLabel(role) {
  if (role === "admin") return "Trainer / Admin";
  if (role === "player") return "Spieler";
  return "Öffentliche Ansicht";
}

function currentTeam() {
  return state.teams.get(state.currentTeamId) || null;
}

function isAdmin(team = currentTeam()) {
  return team?.membershipRole === "admin";
}

function isMember(team = currentTeam()) {
  return team?.membershipRole === "admin" || team?.membershipRole === "player";
}

function extractCode(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, window.location.href);
    const code = url.searchParams.get("join");
    if (code) return code.trim().toUpperCase();
  } catch (_) {
    // Plain codes intentionally fall through.
  }
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function showTeamsView() {
  el("teams-view").classList.remove("hidden");
  el("team-detail-view").classList.add("hidden");
}

function showDetailView() {
  if (!currentTeam()) {
    showTeamsView();
    return;
  }
  el("teams-view").classList.add("hidden");
  el("team-detail-view").classList.remove("hidden");
}

function setCurrentTeamSummary() {
  const team = currentTeam();
  el("current-team-name").textContent = team?.name || "Lokales Board";
  el("current-team-role").textContent = team ? roleLabel(team.membershipRole) : "Lokal bearbeiten";
  el("current-team-select").value = state.currentTeamId;
  window.taktikboard?.setReadOnly(Boolean(team) && !isAdmin(team));
}

function renderTeamSelect() {
  const select = el("current-team-select");
  clear(select);
  const local = document.createElement("option");
  local.value = "";
  local.textContent = "Lokales Board";
  select.appendChild(local);

  [...state.teams.values()]
    .sort((a, b) => a.name.localeCompare(b.name, "de"))
    .forEach((team) => {
      const option = document.createElement("option");
      option.value = team.id;
      option.textContent = `${team.isPrivate ? "🔒" : "🌐"} ${team.name}`;
      select.appendChild(option);
    });
  select.value = state.currentTeamId;
}

function renderTeamList() {
  const list = el("team-list");
  clear(list);
  const teams = [...state.teams.values()].sort((a, b) => {
    const aMember = a.membershipRole ? 0 : 1;
    const bMember = b.membershipRole ? 0 : 1;
    return aMember - bMember || a.name.localeCompare(b.name, "de");
  });

  if (!teams.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Noch keine Teams vorhanden. Erstelle ein Team oder tritt mit einem Teamcode bei.";
    list.appendChild(empty);
    return;
  }

  teams.forEach((team) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `team-card${team.id === state.currentTeamId ? " active" : ""}`;
    const title = document.createElement("h3");
    title.textContent = `${team.isPrivate ? "🔒" : "🌐"} ${team.name}`;
    const description = document.createElement("p");
    description.textContent = team.description || "Keine Beschreibung";
    const meta = document.createElement("div");
    meta.className = "team-card-meta";
    const visibility = document.createElement("span");
    visibility.textContent = team.isPrivate ? "Privat" : "Öffentlich";
    const role = document.createElement("span");
    role.textContent = roleLabel(team.membershipRole);
    meta.append(visibility, role);
    card.append(title, description, meta);
    card.addEventListener("click", async () => {
      await selectTeam(team.id, true);
    });
    list.appendChild(card);
  });
}

async function loadTeams(preferredTeamId = state.currentTeamId) {
  if (!state.user) return;
  const teams = new Map();

  const publicSnapshot = await getDocs(query(collection(db, "teams"), where("isPrivate", "==", false)));
  publicSnapshot.forEach((snapshot) => {
    teams.set(snapshot.id, { id: snapshot.id, ...snapshot.data(), membershipRole: null });
  });

  const membershipSnapshot = await getDocs(collection(db, "users", state.user.uid, "teams"));
  await Promise.all(membershipSnapshot.docs.map(async (membershipDoc) => {
    const membership = membershipDoc.data();
    const teamSnapshot = await getDoc(doc(db, "teams", membershipDoc.id));
    if (!teamSnapshot.exists()) return;
    const existing = teams.get(teamSnapshot.id) || {};
    teams.set(teamSnapshot.id, {
      ...existing,
      id: teamSnapshot.id,
      ...teamSnapshot.data(),
      membershipRole: membership.role
    });
  }));

  state.teams = teams;
  state.currentTeamId = teams.has(preferredTeamId) ? preferredTeamId : "";
  state.currentTacticId = "";
  state.currentTacticName = "";
  renderTeamSelect();
  renderTeamList();
  setCurrentTeamSummary();
}

async function selectTeam(teamId, openDetails = false) {
  state.currentTeamId = state.teams.has(teamId) ? teamId : "";
  state.currentTacticId = "";
  state.currentTacticName = "";
  renderTeamList();
  setCurrentTeamSummary();
  if (state.currentTeamId) {
    await renderTeamDetails();
    if (openDetails) showDetailView();
  } else {
    showTeamsView();
  }
}

function formatDate(value) {
  try {
    return value?.toDate().toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }) || "";
  } catch (_) {
    return "";
  }
}

async function renderTactics() {
  const team = currentTeam();
  const list = el("tactic-list");
  clear(list);
  if (!team) return;

  try {
    const snapshot = await getDocs(query(
      collection(db, "teams", team.id, "taktiken"),
      orderBy("updatedAt", "desc")
    ));
    if (snapshot.empty) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "Dieses Team hat noch keine Taktiken.";
      list.appendChild(empty);
      return;
    }

    snapshot.forEach((tacticDoc) => {
      const tactic = tacticDoc.data();
      const row = document.createElement("div");
      row.className = "list-card";
      const main = document.createElement("div");
      main.className = "list-card-main";
      const title = document.createElement("strong");
      title.textContent = tactic.name || "Unbenannte Taktik";
      const date = document.createElement("span");
      date.textContent = formatDate(tactic.updatedAt || tactic.createdAt);
      main.append(title, date);

      const actions = document.createElement("div");
      actions.className = "list-actions";
      actions.appendChild(makeButton("Öffnen", "small-btn", () => openTactic(tacticDoc.id, tactic)));
      if (isAdmin(team)) {
        actions.appendChild(makeButton("Kopieren", "small-btn", () => openCopyDialog(tacticDoc.id)));
        actions.appendChild(makeButton("Löschen", "small-btn", () => deleteTactic(tacticDoc.id, tactic.name)));
      }
      row.append(main, actions);
      list.appendChild(row);
    });
  } catch (error) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = friendlyError(error);
    list.appendChild(empty);
  }
}

async function renderMembers() {
  const list = el("member-list");
  clear(list);
  const team = currentTeam();
  if (!team || !isMember(team)) return;

  try {
    const snapshot = await getDocs(collection(db, "teams", team.id, "members"));
    snapshot.forEach((memberDoc) => {
      const member = memberDoc.data();
      const row = document.createElement("div");
      row.className = "list-card";
      const main = document.createElement("div");
      main.className = "list-card-main";
      const title = document.createElement("strong");
      title.textContent = memberDoc.id === state.user.uid ? "Du" : `Mitglied ${memberDoc.id.slice(0, 8)}…`;
      const role = document.createElement("span");
      role.textContent = `${roleLabel(member.role)}${memberDoc.id === team.ownerId ? " · Besitzer" : ""}`;
      main.append(title, role);
      row.appendChild(main);

      if (isAdmin(team) && memberDoc.id !== team.ownerId) {
        const actions = document.createElement("div");
        actions.className = "list-actions";
        const roleSelect = document.createElement("select");
        roleSelect.setAttribute("aria-label", "Mitgliedsrolle");
        [["player", "Spieler"], ["admin", "Trainer / Admin"]].forEach(([value, label]) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          roleSelect.appendChild(option);
        });
        roleSelect.value = member.role;
        roleSelect.addEventListener("change", async () => {
          await runAction(() => api.updateMemberRole({ teamId: team.id, userId: memberDoc.id, role: roleSelect.value }), "Rolle aktualisiert.");
          await renderMembers();
        });
        actions.append(roleSelect, makeButton("Entfernen", "small-btn", async () => {
          if (!confirm("Dieses Mitglied wirklich entfernen?")) return;
          await runAction(() => api.removeMember({ teamId: team.id, userId: memberDoc.id }), "Mitglied entfernt.");
          await renderMembers();
        }));
        row.appendChild(actions);
      }
      list.appendChild(row);
    });
  } catch (error) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = friendlyError(error);
    list.appendChild(empty);
  }
}

async function renderTeamDetails() {
  const team = currentTeam();
  if (!team) return;
  el("detail-team-name").textContent = team.name;
  el("detail-team-description").textContent = team.description || "Keine Beschreibung";
  el("detail-team-visibility").textContent = `${team.isPrivate ? "🔒 Privat" : "🌐 Öffentlich"} · ${roleLabel(team.membershipRole)}`;
  el("settings-team-name").value = team.name;
  el("settings-team-description").value = team.description || "";
  el("settings-team-private").checked = Boolean(team.isPrivate);

  document.querySelectorAll("#team-detail-view .admin-only").forEach((node) => node.classList.toggle("hidden", !isAdmin(team)));
  document.querySelectorAll("#team-detail-view .member-only").forEach((node) => node.classList.toggle("hidden", !isMember(team)));
  el("change-password-form").classList.toggle("hidden", !team.isPrivate);
  el("delete-team-btn").classList.toggle("hidden", team.ownerId !== state.user.uid);
  await Promise.all([renderTactics(), renderMembers()]);
}

function openTactic(tacticId, tactic) {
  const storedFrames = tactic.frames || tactic.data?.frames || tactic.data;
  try {
    window.taktikboard.loadNormalizedFrames(storedFrames);
    state.currentTacticId = tacticId;
    state.currentTacticName = tactic.name || "Unbenannte Taktik";
    window.taktikboard.setReadOnly(!isAdmin());
    el("status").textContent = `${state.currentTacticName} · ${roleLabel(currentTeam()?.membershipRole)}`;
    closePanel();
  } catch (error) {
    notice(error.message, true);
  }
}

async function deleteTactic(tacticId, name) {
  if (!confirm(`Taktik „${name || "Unbenannt"}“ wirklich löschen?`)) return;
  await runAction(
    () => deleteDoc(doc(db, "teams", state.currentTeamId, "taktiken", tacticId)),
    "Taktik gelöscht."
  );
  if (state.currentTacticId === tacticId) {
    state.currentTacticId = "";
    state.currentTacticName = "";
  }
  await renderTactics();
}

function openCopyDialog(tacticId) {
  const targets = [...state.teams.values()].filter((team) => team.membershipRole === "admin" && team.id !== state.currentTeamId);
  if (!targets.length) {
    notice("Du benötigst ein weiteres Team mit Administratorrechten als Kopierziel.", true);
    return;
  }
  state.pendingCopyTacticId = tacticId;
  const select = el("copy-target-team");
  clear(select);
  targets.forEach((team) => {
    const option = document.createElement("option");
    option.value = team.id;
    option.textContent = team.name;
    select.appendChild(option);
  });
  el("copy-tactic-dialog").showModal();
}

async function runAction(action, successMessage) {
  if (state.busy) return null;
  setBusy(true);
  clearNotice();
  try {
    const result = await action();
    if (successMessage) notice(successMessage);
    return result;
  } catch (error) {
    notice(friendlyError(error), true);
    return null;
  } finally {
    setBusy(false);
  }
}

async function saveTactic() {
  const team = currentTeam();
  if (!team) {
    openPanel(false);
    notice("Wähle zuerst ein Team aus oder erstelle ein neues Team.", true);
    return;
  }
  if (!isAdmin(team)) {
    openPanel(true);
    notice("Nur Trainer und Administratoren dürfen Taktiken speichern.", true);
    return;
  }

  const name = prompt("Name der Taktik:", state.currentTacticName || "Neue Taktik")?.trim();
  if (!name) return;

  let normalizedFrames;
  try {
    normalizedFrames = window.taktikboard.getNormalizedFrames();
  } catch (error) {
    alert(error.message);
    return;
  }

  try {
    if (state.currentTacticId) {
      await updateDoc(doc(db, "teams", team.id, "taktiken", state.currentTacticId), {
        name,
        frames: normalizedFrames,
        updatedBy: state.user.uid,
        updatedAt: serverTimestamp()
      });
    } else {
      const created = await addDoc(collection(db, "teams", team.id, "taktiken"), {
        name,
        frames: normalizedFrames,
        createdBy: state.user.uid,
        updatedBy: state.user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        schemaVersion: 2
      });
      state.currentTacticId = created.id;
    }
    state.currentTacticName = name;
    el("status").textContent = `${name} · gespeichert`;
    alert(`Taktik gespeichert: ${name}`);
  } catch (error) {
    alert(friendlyError(error));
  }
}

function newTactic() {
  if (!isAdmin()) return;
  state.currentTacticId = "";
  state.currentTacticName = "";
  window.taktikboard.setReadOnly(false);
  window.taktikboard.reset();
  el("status").textContent = "Neue, noch nicht gespeicherte Taktik";
  closePanel();
}

function openPanel(showDetails = false) {
  clearNotice();
  el("team-modal").classList.remove("hidden");
  if (showDetails && currentTeam()) {
    showDetailView();
    renderTeamDetails();
  } else {
    showTeamsView();
  }
}

function closePanel() {
  el("team-modal").classList.add("hidden");
}

async function createTeam(event) {
  event.preventDefault();
  const isPrivate = el("create-team-private").checked;
  const result = await runAction(() => api.createTeam({
    name: el("create-team-name").value.trim(),
    description: el("create-team-description").value.trim(),
    isPrivate,
    password: isPrivate ? el("create-team-password").value : ""
  }), "Team erstellt.");
  if (!result) return;
  event.target.reset();
  event.target.classList.add("hidden");
  el("create-team-password-row").classList.add("hidden");
  await loadTeams(result.data.teamId);
  await selectTeam(result.data.teamId, true);
}

async function joinTeam(event) {
  event.preventDefault();
  const code = extractCode(el("join-team-code").value);
  const result = await runAction(() => api.joinTeam({
    code,
    password: el("join-team-password").value
  }), "Team beigetreten.");
  if (!result) return;
  event.target.reset();
  event.target.classList.add("hidden");
  await loadTeams(result.data.teamId);
  await selectTeam(result.data.teamId, true);
}

async function saveTeamSettings(event) {
  event.preventDefault();
  const team = currentTeam();
  if (!team || !isAdmin(team)) return;
  const isPrivate = el("settings-team-private").checked;
  let password = "";
  if (isPrivate && !team.isPrivate) {
    password = prompt("Lege für das private Team ein Passwort mit mindestens 8 Zeichen fest:") || "";
    if (!password) return;
  }
  const result = await runAction(() => api.updateTeam({
    teamId: team.id,
    name: el("settings-team-name").value.trim(),
    description: el("settings-team-description").value.trim(),
    isPrivate,
    password
  }), "Teameinstellungen gespeichert.");
  if (!result) return;
  await loadTeams(team.id);
  await selectTeam(team.id, true);
}

async function changePassword(event) {
  event.preventDefault();
  const password = el("settings-team-password").value;
  const result = await runAction(
    () => api.changeTeamPassword({ teamId: state.currentTeamId, password }),
    "Team-Passwort geändert."
  );
  if (result) event.target.reset();
}

async function deleteTeam() {
  const team = currentTeam();
  if (!team || !isAdmin(team)) return;
  const confirmation = prompt(`Zum Löschen „${team.name}“ eingeben:`);
  if (confirmation !== team.name) return;
  const result = await runAction(() => api.deleteTeam({ teamId: team.id }), "Team gelöscht.");
  if (!result) return;
  await loadTeams("");
  showTeamsView();
}

async function copyInvitation() {
  const team = currentTeam();
  if (!team || !isMember(team)) return;
  const link = `${window.location.origin}${window.location.pathname}?join=${encodeURIComponent(team.inviteCode)}`;
  try {
    await navigator.clipboard.writeText(link);
    notice(`Einladungslink kopiert. Teamcode: ${team.inviteCode}`);
  } catch (_) {
    prompt("Einladungslink kopieren:", link);
  }
}

function bindUi() {
  el("current-team-select").addEventListener("change", (event) => selectTeam(event.target.value, false));
  el("show-create-team").addEventListener("click", () => {
    el("create-team-form").classList.toggle("hidden");
    el("join-team-form").classList.add("hidden");
  });
  el("show-join-team").addEventListener("click", () => {
    el("join-team-form").classList.toggle("hidden");
    el("create-team-form").classList.add("hidden");
  });
  document.querySelectorAll(".cancel-form").forEach((button) => button.addEventListener("click", () => button.closest("form").classList.add("hidden")));
  el("create-team-private").addEventListener("change", (event) => {
    el("create-team-password-row").classList.toggle("hidden", !event.target.checked);
    el("create-team-password").required = event.target.checked;
  });
  el("create-team-form").addEventListener("submit", createTeam);
  el("join-team-form").addEventListener("submit", joinTeam);
  el("back-to-teams").addEventListener("click", showTeamsView);
  el("new-tactic-btn").addEventListener("click", newTactic);
  el("copy-invite-btn").addEventListener("click", copyInvitation);
  el("team-settings-form").addEventListener("submit", saveTeamSettings);
  el("change-password-form").addEventListener("submit", changePassword);
  el("delete-team-btn").addEventListener("click", deleteTeam);
  el("migrate-legacy-btn").addEventListener("click", async () => {
    if (!confirm("Bestehende Dokumente aus „spielzuege“ in dieses Team kopieren? Die Originale bleiben erhalten.")) return;
    const result = await runAction(() => api.migrateLegacyTactics({ teamId: state.currentTeamId }), "Alte Spielzüge wurden übernommen.");
    if (result) {
      notice(`${result.data.copied} Spielzüge übernommen, ${result.data.skipped} bereits vorhanden.`);
      await renderTactics();
    }
  });
  el("confirm-copy-tactic").addEventListener("click", async (event) => {
    event.preventDefault();
    const targetTeamId = el("copy-target-team").value;
    const result = await runAction(() => api.copyTactic({
      sourceTeamId: state.currentTeamId,
      targetTeamId,
      tacticId: state.pendingCopyTacticId
    }), "Taktik kopiert.");
    if (result) el("copy-tactic-dialog").close();
  });
  el("team-modal").addEventListener("click", (event) => {
    if (event.target === el("team-modal")) closePanel();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el("team-modal").classList.contains("hidden")) closePanel();
  });
}

async function initializeForUser(user) {
  state.user = user;
  el("auth-status").textContent = `Angemeldet · ${user.uid.slice(0, 8)}…`;
  try {
    await loadTeams();
    const joinCode = new URLSearchParams(window.location.search).get("join");
    if (joinCode) {
      openPanel(false);
      el("join-team-form").classList.remove("hidden");
      el("join-team-code").value = joinCode;
      el("join-team-password").focus();
    }
  } catch (error) {
    openPanel(false);
    notice(`${friendlyError(error)} Prüfe, ob Authentication, Functions und Firestore-Regeln bereitgestellt wurden.`, true);
  }
}

bindUi();

window.teamManager = {
  open: openPanel,
  close: closePanel,
  saveTactic
};

onAuthStateChanged(auth, async (user) => {
  if (user) {
    await initializeForUser(user);
    return;
  }
  el("auth-status").textContent = "Anonyme Anmeldung …";
  try {
    await signInAnonymously(auth);
  } catch (error) {
    openPanel(false);
    notice(`Anmeldung fehlgeschlagen: ${friendlyError(error)}`, true);
  }
});
