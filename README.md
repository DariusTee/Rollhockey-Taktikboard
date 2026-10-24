# Rollhockey-Taktikboard

Browserbasiertes Taktikboard für Rollhockey mit animierten Frames, Bild-/GIF-Export und Firebase-gestützter Teamverwaltung.

## Funktionen

- Spieler, Ball sowie Lauf-, Pass- und Schusswege auf einem Canvas bearbeiten
- Taktiken aus mehreren Frames interpoliert abspielen
- PNG, GIF und Challenge-JSON exportieren
- öffentliche und private Teams erstellen und verwalten
- privaten Teams über Teamcode/Einladungslink und Passwort beitreten
- Rollen `admin` (Trainer/Administrator) und `player` (Spieler)
- Taktiken innerhalb eines Teams erstellen, aktualisieren, öffnen und löschen
- Taktiken zwischen Teams kopieren
- bestehende Dokumente aus `spielzuege` nicht-destruktiv in ein Team übernehmen

## Architektur

Die Website bleibt buildlos und wird direkt aus HTML und JavaScript ausgeliefert:

- `index.html`: Canvas-Editor und Teamoberfläche
- `team-management.js`: Firebase Authentication, Teamansichten und Taktikzugriff
- `firestore.rules`: clientseitig wirksame Zugriffskontrolle
- `functions/index.js`: vertrauenswürdige Team-, Rollen-, Passwort- und Migrationsoperationen
- `tests/firestore.rules.test.mjs`: automatisierte Berechtigungstests für den Firestore Emulator

Passwörter werden nie im Browser oder im Teamdokument gespeichert. Die Callable Functions hashen sie mit Node.js `scrypt`, einem zufälligen Salt und konstantem Zeitvergleich. Hash und Salt liegen in `teamSecrets/{teamId}`, das von den Security Rules vollständig für Clients gesperrt ist. Fehlgeschlagene Beitrittsversuche werden pro Benutzer, Teamcode und IP zeitlich begrenzt.

## Firestore-Struktur

```text
teams/{teamId}
  name, description, ownerId, isPrivate, inviteCode, createdAt, updatedAt
  members/{userId}
    role, joinedAt
  taktiken/{taktikId}
    name, frames, createdBy, updatedBy, createdAt, updatedAt, schemaVersion

users/{userId}/teams/{teamId}
  role, joinedAt

teamCodes/{inviteCode}
  teamId

teamSecrets/{teamId}
  algorithm, salt, hash, parameters, updatedAt

joinRateLimits/{hash}
  attempts, windowStartedAt, blockedUntil, expiresAt

spielzuege/{legacyId}
  bestehende unveränderte Altdaten
```

`teamCodes`, `teamSecrets` und `joinRateLimits` sind ausschließlich über das Firebase Admin SDK in Cloud Functions zugänglich. Der Index unter `users/{userId}/teams` ermöglicht es einem Benutzer, seine privaten Mitgliedschaften zu finden, ohne fremde private Teams auflisten zu können.

## Firebase vorbereiten

Voraussetzungen: Node.js 22, Java für den Emulator und Firebase CLI. Cloud Functions erfordern für die Bereitstellung in der Regel den Blaze-Tarif.

1. In der Firebase Console das Projekt `rollhockey-taktikboard` öffnen.
2. Unter **Authentication → Sign-in method** die anonyme Anmeldung aktivieren.
3. Cloud Firestore im Native Mode aktivieren.
4. Optional, aber empfohlen: App Check für die Web-App konfigurieren. Erst nach erfolgreichem Client-Rollout `enforceAppCheck` für die Callable Functions aktivieren.
5. Optional eine TTL-Richtlinie für `joinRateLimits.expiresAt` aktivieren, damit abgelaufene Rate-Limit-Dokumente automatisch entfernt werden.

Anonyme Konten behalten ihre UID im selben Browser. Wenn später E-Mail-, Google- oder eine andere dauerhafte Anmeldung ergänzt wird, muss der neue Anmeldeanbieter mit dem bestehenden anonymen Benutzer über Firebase Auth `linkWithCredential` verknüpft werden. Ein normales Abmelden und Neuanmelden mit einer anderen UID würde Mitgliedschaften nicht automatisch übertragen.

## Installation

Im Repository-Stamm:

```powershell
npm install
npm --prefix functions install
```

## Lokale Tests

Die Security-Rules-Tests starten automatisch einen isolierten Firestore Emulator:

```powershell
npm test
```

Die komplette lokale Firebase-Umgebung startet mit:

```powershell
npm run serve
```

Die Website ist anschließend unter `http://localhost:5000` erreichbar. Der produktive Client nutzt standardmäßig das konfigurierte Firebase-Projekt; für eine vollständige Client-Integration gegen Emulatoren müssten zusätzlich die `connect*Emulator`-Aufrufe in `team-management.js` aktiviert werden.

## Deployment

Einmalig anmelden und Projekt prüfen:

```powershell
npx firebase-tools login
npx firebase-tools use rollhockey-taktikboard
```

Zuerst Regeln und Functions bereitstellen, danach Hosting:

```powershell
npx firebase-tools deploy --only firestore:rules
npx firebase-tools deploy --only functions
npx firebase-tools deploy --only hosting
```

Oder gemeinsam:

```powershell
npx firebase-tools deploy --only firestore:rules,functions,hosting
```

Nach dem Deployment mindestens folgende Fälle mit zwei getrennten Browserprofilen prüfen:

1. Öffentliches Team erstellen und als Außenstehender Taktiken ansehen.
2. Privates Team erstellen, mit falschem Passwort scheitern und mit korrektem Passwort beitreten.
3. Als Spieler eine Taktik öffnen und abspielen; Bearbeiten, Speichern und Löschen müssen gesperrt sein.
4. Als Administrator Taktiken und Rollen verwalten.
5. Als Nicht-Besitzer prüfen, dass das Team nicht gelöscht werden kann.

## Migration vorhandener Spielzüge

Die Collection `spielzuege` wird weder überschrieben noch gelöscht. Ein Teamadministrator kann in der Teamübersicht **Alte Spielzüge sicher übernehmen** wählen. Die Function kopiert jedes geeignete Dokument unter der deterministischen ID `legacy_{legacyId}` nach `teams/{teamId}/taktiken`. Wiederholte Aufrufe überspringen bereits kopierte Dokumente.

Nach erfolgreicher Kontrolle kann der Zugriff auf die Alt-Collection in einer späteren, bewusst geplanten Migration weiter eingeschränkt werden. Eine automatische Löschung findet nicht statt.

## Betrieb und mögliche Kosten

- Statisches Firebase Hosting besitzt ein kostenfreies Kontingent; darüber hinaus fallen Hosting- und Transferkosten an.
- Firestore berechnet Lese-, Schreib- und Löschoperationen sowie gespeichertes Datenvolumen. Die öffentliche Teamübersicht liest alle öffentlichen Teamdokumente und sollte bei starkem Wachstum paginiert werden.
- Callable Cloud Functions verursachen abhängig von Aufrufen, Laufzeit und ausgehendem Traffic Kosten und setzen für das Deployment üblicherweise den Blaze-Tarif voraus.
- Anonyme Firebase-Auth-Konten unterliegen Quoten. Bei Identity Platform kann die automatische Bereinigung alter anonymer Konten aktiviert werden; für aktive Besitzerkonten ist vorher eine dauerhafte Anmeldemethode zu verknüpfen.

## Sicherheitshinweise

- Firestore-Regeln vor Functions und Website deployen, damit der bisherige Fehler `Missing or insufficient permissions` nicht durch alte oder unvollständige Regeln entsteht.
- Team- und Mitgliedschaftsänderungen laufen ausschließlich über Callable Functions. Client-Direktzugriffe werden abgewiesen.
- Firebase-Webkonfigurationen sind öffentliche Projektkennungen, keine administrativen Geheimnisse. Service-Account-Schlüssel gehören niemals in dieses Repository.
- Für Produktionsbetrieb App Check, Budgetwarnungen, Function-Logs und Auth-Quoten überwachen.

## Offene Produktionspunkte

- App Check ist vorbereitet, aber noch nicht erzwungen, damit die bestehende Web-App nicht vor der Registrierung eines App-Check-Providers ausgesperrt wird.
- Eine dauerhafte Kontoanmeldung und das Verknüpfen anonymer Konten sind noch nicht als Oberfläche implementiert.
- Die öffentliche Teamliste benötigt bei starkem Wachstum Pagination oder eine gezielte Suche.
- `datenschutz.html` sollte vor dem Produktivstart rechtlich geprüft und an Firebase Authentication, Firestore, Cloud Functions sowie die technische IP-Verarbeitung für Rate-Limits angepasst werden.
- Die responsive Oberfläche wurde strukturell, per HTTP und mit Emulatorintegration geprüft; eine abschließende visuelle Prüfung auf realen Smartphones und in den unterstützten Browsern bleibt erforderlich.
