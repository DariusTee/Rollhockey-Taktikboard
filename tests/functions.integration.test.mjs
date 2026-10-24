import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { deleteApp, initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  signInAnonymously
} from "firebase/auth";
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  serverTimestamp,
  setDoc
} from "firebase/firestore";
import {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable
} from "firebase/functions";

const config = {
  apiKey: "demo-key",
  authDomain: "demo-rollhockey-taktikboard.firebaseapp.com",
  projectId: "demo-rollhockey-taktikboard"
};

const clients = [];

async function createClient(name) {
  const app = initializeApp(config, name);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, "europe-west1");
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  const credential = await signInAnonymously(auth);
  const client = {
    app,
    auth,
    db,
    functions,
    uid: credential.user.uid,
    call(name) { return httpsCallable(functions, name); }
  };
  clients.push(client);
  return client;
}

let owner;
let player;
let outsider;

before(async () => {
  [owner, player, outsider] = await Promise.all([
    createClient("owner"),
    createClient("player"),
    createClient("outsider")
  ]);
});

after(async () => {
  await Promise.all(clients.map((client) => deleteApp(client.app)));
});

test("private Teams prüfen Passwörter serverseitig und registrieren Spieler", async () => {
  const created = await owner.call("createTeam")({
    name: "Private Wölfe",
    description: "Testteam",
    isPrivate: true,
    password: "Sehr sicher 42!"
  });
  const { teamId, inviteCode } = created.data;
  assert.ok(teamId);
  assert.match(inviteCode, /^[A-HJ-NP-Z2-9]{10}$/);

  await assert.rejects(
    player.call("joinTeam")({ code: inviteCode, password: "Falsch!" }),
    (error) => error.code === "functions/permission-denied"
  );

  const joined = await player.call("joinTeam")({ code: inviteCode, password: "Sehr sicher 42!" });
  assert.equal(joined.data.teamId, teamId);
  assert.equal(joined.data.role, "player");
  assert.equal((await getDoc(doc(player.db, "teams", teamId))).exists(), true);

  await assert.rejects(
    player.call("updateTeam")({ teamId, name: "Manipuliert", description: "", isPrivate: true }),
    (error) => error.code === "functions/permission-denied"
  );

  await owner.call("updateMemberRole")({ teamId, userId: player.uid, role: "admin" });
  await player.call("updateTeam")({
    teamId,
    name: "Private Wölfe 2",
    description: "Von einem freigegebenen Trainer geändert",
    isPrivate: true
  });
  assert.equal((await getDoc(doc(owner.db, "teams", teamId))).data().name, "Private Wölfe 2");
});

test("Passwortänderung invalidiert das alte Passwort", async () => {
  const created = await owner.call("createTeam")({
    name: "Passwortteam",
    description: "",
    isPrivate: true,
    password: "Altes Passwort 1!"
  });
  await owner.call("changeTeamPassword")({ teamId: created.data.teamId, password: "Neues Passwort 2!" });

  await assert.rejects(
    outsider.call("joinTeam")({ code: created.data.inviteCode, password: "Altes Passwort 1!" }),
    (error) => error.code === "functions/permission-denied"
  );
  const joined = await outsider.call("joinTeam")({ code: created.data.inviteCode, password: "Neues Passwort 2!" });
  assert.equal(joined.data.role, "player");
});

test("öffentliche Teams sind lesbar und Admins können Taktiken zwischen Teams kopieren", async () => {
  const source = await owner.call("createTeam")({ name: "Quelle", description: "", isPrivate: false });
  const target = await owner.call("createTeam")({ name: "Ziel", description: "", isPrivate: false });
  assert.equal((await getDoc(doc(outsider.db, "teams", source.data.teamId))).exists(), true);

  const tacticId = "powerplay";
  await setDoc(doc(owner.db, "teams", source.data.teamId, "taktiken", tacticId), {
    name: "Powerplay",
    frames: [{ players: [], ball: { x: 0.5, y: 0.5, visible: true }, arrows: [] }],
    createdBy: owner.uid,
    updatedBy: owner.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    schemaVersion: 2
  });

  const copied = await owner.call("copyTactic")({
    sourceTeamId: source.data.teamId,
    targetTeamId: target.data.teamId,
    tacticId
  });
  assert.equal(copied.data.teamId, target.data.teamId);
  const tactics = await getDocs(collection(owner.db, "teams", target.data.teamId, "taktiken"));
  assert.equal(tactics.size, 1);
  assert.equal(tactics.docs[0].data().name, "Powerplay (Kopie)");
});
