# AGENTS.md

## Zweck und Geltungsbereich

Dieses Repository enthält ein browserbasiertes Rollhockey-Taktikboard. Diese Datei gilt für das gesamte Repository und soll Änderungen am Board erleichtern, ohne bestehende Spielzüge, Exporte oder die Touch-Bedienung unbeabsichtigt zu beschädigen.

Die Anwendung ist eine statische Single-Page-Webseite ohne Frontend-Build-Schritt oder Framework. Canvas und Oberfläche liegen in `index.html`; Firebase- und Teamlogik sind in `team-management.js` getrennt. Vertrauenswürdige Verwaltungsaktionen laufen als Firebase Cloud Functions unter `functions/`.

## Produktüberblick

Das Taktikboard zeigt ein Rollhockeyfeld auf einem HTML-Canvas. Trainer können zwei Mannschaften und einen Ball positionieren, Lauf-, Pass- und Schusswege einzeichnen und mehrere Zustände als Frames anlegen. Die Frames lassen sich interpoliert abspielen oder als Bild, GIF beziehungsweise Challenge-Datei exportieren.

Die zentrale Bedienung befindet sich in der schwebenden rechten Werkzeugleiste:

- Vollbildmodus ein- und ausschalten.
- Spieler oder Ball auswählen und per Maus beziehungsweise Touch verschieben.
- Feldspieler zu Team A oder B hinzufügen.
- Laufpfeile (grün/gestrichelt), Passpfeile (blau/durchgezogen) und Schusspfeile (rot/gepunktet) durch Ziehen auf dem Feld anlegen.
- Den Ball an einer Stelle setzen oder Spieler beziehungsweise Ball löschen.
- Frames hinzufügen, entfernen, auswählen und als Schleifenanimation abspielen.
- Den aktuellen Frame als PNG oder den kompletten Ablauf als GIF herunterladen.
- Spielzüge in Firestore speichern und aus Firestore laden.
- Einen Ablauf als JSON-Challenge herunterladen.
- Die Werkzeugleiste über den runden Menüknopf ein- und ausblenden.

Beim Start wird ein Standardaufbau mit je einem Torwart und vier Feldspielern pro Team sowie einem sichtbaren Ball in der Feldmitte erzeugt. Team A ist blau, Team B rot; Torwarte haben jeweils eine abweichende Farbe und eine quadratische Form.

## Dateistruktur

- `index.html`: Canvas-Hauptanwendung mit Inline-CSS, HTML und klassischem JavaScript.
- `team-management.js`: anonyme Anmeldung, Teamansichten, Rollenstatus und Taktik-CRUD im Browser.
- `bilder_webp_Spielzüge_Rollhockey Spielfeld.png`: Spielfeld-Hintergrund des Canvas (1023 × 1538 Pixel). Der Dateiname enthält Leerzeichen und Umlaute; Referenzen darauf nicht leichtfertig ändern.
- `gif.worker.js`: lokaler Worker für `gif.js`; wird beim GIF-Export relativ über `./gif.worker.js` geladen.
- `impressum.html`: statische Impressumsseite.
- `datenschutz.html`: statische Datenschutzerklärung.
- `functions/index.js`: Callable Functions für Teams, Mitgliedschaften, Rollen, Kopieren, Migration und Löschung.
- `functions/passwords.js`: isolierte `scrypt`-Hash- und Prüfimplementierung.
- `firestore.rules`: Zugriffskontrolle für öffentliche/private Teams und Rollen.
- `firebase.json` / `.firebaserc`: Firebase-Deployment und Emulatoren.
- `tests/`: HTML-/JavaScript- und Firestore-Regeltests.
- `README.md`: Einrichtung, Datenstruktur, Migration, Tests, Deployment und Kostenhinweise.

Das Root-`package.json` enthält ausschließlich Entwicklungswerkzeuge für Tests und Firebase CLI; die Website selbst bleibt buildlos. `functions/package.json` beschreibt die separat deployte Node-22-Laufzeit.

## Laufzeit und Abhängigkeiten

Die Seite benötigt einen modernen Browser mit Canvas-, Fullscreen-, Blob-, Download- und ES-Module-Unterstützung. Sie lädt zur Laufzeit:

- `gif.js` 0.2.0 von cdnjs;
- Firebase App, Authentication, Firestore und Functions 13.1.0 von Googles CDN;
- den lokalen GIF-Worker und das lokale Spielfeldbild.

Die Firebase-Clientkonfiguration ist in `team-management.js` eingebettet. Zugriffsrechte werden durch die versionierten Firestore-Regeln und Callable Functions abgesichert. Passwort-Hash und Salt liegen ausschließlich in `teamSecrets`; Clients erhalten darauf keinerlei Zugriff. Keine privaten Schlüssel oder administrativen Zugangsdaten in die Seite einbauen.

Die Anwendung sollte über HTTP(S) statt direkt als `file://`-Datei geöffnet werden, da Module, CDN-Ressourcen und Web Worker sonst je nach Browser blockiert werden. Lokal genügt im Repository-Stamm zum Beispiel:

```powershell
python -m http.server 8000
```

Danach `http://localhost:8000/` öffnen. Für die reine Canvas-Bedienung sind keine Installation und kein Build nötig; Auth, Firestore, Functions und die CDN-Bibliotheken benötigen eine Internetverbindung. Für die Firebase-Emulatoren und Tests gelten die Befehle aus `README.md`.

## Architektur und Datenfluss

### Initialisierung und Darstellung

1. Das Spielfeldbild wird asynchron geladen.
2. Aus Bild- und Fenstergröße werden die internen Canvas-Maße `W` und `H` berechnet.
3. `defaultState()` erzeugt den ersten Frame.
4. `drawState()` zeichnet in dieser Reihenfolge das Spielfeld, die Pfeile, den Ball und die Spieler.
5. `draw()` zeichnet den gewählten Zustand auf das sichtbare Canvas.

Die sichtbare CSS-Größe des Canvas und seine interne Pixelgröße sind getrennt. `getMousePos()` rechnet Maus- und Touch-Koordinaten deshalb von der DOM-Größe auf `W`/`H` um. Bei einer Fenstergrößenänderung skaliert `rescaleFrames()` alle Spieler-, Ball- und Pfeilkoordinaten auf die neuen Canvas-Maße.

### Globaler Zustand

Die Anwendung arbeitet bewusst mit globalem Zustand im klassischen Script:

- `frames`: Array sämtlicher Spielzustände.
- `currentFrame`: nullbasierter Index des bearbeiteten Frames.
- `tool`: aktives Werkzeug (`select`, `run`, `pass`, `shoot`, `ball`, `delete`).
- `dragTarget`, `dragOffX`, `dragOffY`: aktueller Ziehvorgang.
- `arrowStart`: Startpunkt eines neuen Pfeils.
- `selectedId`: optisch ausgewählter Spieler.
- `playing` und `animFrame`: Status und Request-ID der Animation.
- `boardReadOnly`: sperrt alle mutierenden Boardaktionen für Spieler und öffentliche Betrachter.

`team-management.js` hält separat Benutzer, zugängliche Teams, aktives Team und aktive Taktik. Der Austausch mit dem Canvas erfolgt nur über `window.taktikboard` (`getNormalizedFrames`, `loadNormalizedFrames`, `reset`, `setReadOnly`).

Ein Frame besitzt sinngemäß dieses Format:

```js
{
  players: [
    { id, team: "A" | "B", role: "gk" | "field", x, y, label }
  ],
  ball: { x, y, visible },
  arrows: [
    { x1, y1, x2, y2, type: "run" | "pass" | "shoot" }
  ]
}
```

Im Arbeitsspeicher sind Koordinaten absolute Canvas-Pixel. Für Firestore und Challenge-JSON normalisiert `normalizeFrames()` die Koordinaten auf Werte relativ zu `W` und `H`; `denormalizeFrames()` wandelt sie beim Laden wieder in Pixel um. Dieses Format ermöglicht das Laden auf abweichenden Bildschirmgrößen.

### Eingabe

Maus- und Touch-Ereignisse teilen sich `startDrag()`, `moveDrag()` und `endDrag()`. Änderungen wirken immer nur auf `frames[currentFrame]`:

- `select`: Trefferprüfung auf Spieler, danach Ball; das Ziel wird bis zum Loslassen verschoben.
- `run`, `pass`, `shoot`: beim Drücken wird der Startpunkt gespeichert, beim Loslassen ein Pfeil angelegt.
- `ball`: setzt Position und `visible = true`.
- `delete`: entfernt getroffene Spieler oder setzt beim Ball `visible = false`.

Die Team-Schaltflächen markieren nur den betreffenden Spieler und wechseln auf `select`; sie versetzen ihn nicht. Neue Spieler werden in der Mitte des aktuellen Frames angelegt.

### Frames und Animation

`addFrame()` klont den aktuellen Frame per JSON-Serialisierung, leert im neuen Frame die Pfeile und fügt ihn direkt danach ein. Positionsänderungen im neuen Frame definieren somit den nächsten Animationsschritt. `delFrame()` lässt mindestens einen Frame bestehen.

`playAnim()` läuft mit `requestAnimationFrame` in einer Endlosschleife. Geschwindigkeit und Anzahl der Zwischenbilder stammen aus denselben Auswahlfeldern wie der GIF-Export. `lerpState()` interpoliert Spieler und Ball linear; Pfeile wechseln ungefähr in der Mitte des Übergangs vom Ausgangs- zum Zielframe.

### Speichern und Exportieren

- PNG: zeichnet nur den aktuellen Frame auf ein Offscreen-Canvas und lädt `rollhockey_frameN.png` herunter.
- GIF: rendert alle Original- und Zwischenframes mit `gif.js`; `gif.worker.js` führt die Kodierung aus. Dateiname: `rollhockey_spielzug.gif`.
- Firestore: Taktiken liegen unter `teams/{teamId}/taktiken/{taktikId}`. Nur Admins dürfen direkt über die Regeln erstellen, aktualisieren und löschen. Spieler und öffentliche Betrachter laden ausschließlich lesend.
- Teamverwaltung: Team-, Rollen-, Passwort-, Beitritts-, Kopier-, Migrations- und Löschaktionen laufen als Callable Functions in `europe-west1`.
- Altdaten: `spielzuege` bleibt unverändert und lesbar. `migrateLegacyTactics` kopiert idempotent nach einem ausgewählten Team; Originale werden nicht gelöscht.
- Challenge: `exportChallengeJSON()` lädt eine JSON-Datei mit Version, Titel, Sportart, Zeitstempel, normalisierten Frames und Quiz-Konfiguration herunter. `startFrame` ist 0; `targetFrame` wird unverändert aus dem Prompt übernommen. Beweglich sind die IDs aller Spieler von Team A im ersten Frame, außerdem der Ball.

## Wichtige Invarianten bei Änderungen

- Spieler-IDs müssen über zusammengehörige Frames stabil bleiben. Gespeicherte Challenges referenzieren diese IDs.
- Für eine zuverlässige Interpolation müssen Spielerzahl und Array-Reihenfolge zwischen benachbarten Frames übereinstimmen. Die aktuelle Interpolation ordnet Spieler nach Array-Index, nicht nach ID, zu.
- Koordinatenänderungen müssen sowohl absolute Arbeitszustände als auch normalisierte Speicherformate berücksichtigen.
- Neue Frame-Eigenschaften müssen durch `cloneState()`, `normalizeFrames()`, `denormalizeFrames()` und gegebenenfalls `lerpState()` durchgereicht werden.
- Änderungen an der Zeichenreihenfolge beeinflussen gleichzeitig Editor, PNG, GIF und Animationsvorschau, weil alle `drawState()` verwenden.
- Maus und Touch verwenden denselben Ablauf. Interaktionsänderungen immer mit beiden Eingabearten prüfen und `passive: false` dort erhalten, wo `preventDefault()` gebraucht wird.
- Dateinamen und relative Asset-Pfade müssen auf einem case-sensitiven Webserver funktionieren.
- Beim Umbau der Firebase-Imports beachten: Das Modulscript stellt Funktionen und Objekte absichtlich auf `window` bereit, damit das nachfolgende klassische Script sie aus Event-Handlern aufrufen kann.

## Bekannte Grenzen und empfindliche Stellen

Diese Punkte beschreiben den aktuellen Ist-Zustand und sollten bei passenden Änderungen gezielt behoben, aber nicht nebenbei verschleiert werden:

- Das Löschwerkzeug löscht Spieler und blendet den Ball aus, bietet aber keine Trefferprüfung zum Löschen von Pfeilen.
- `selectedId` ist global und wird auch von `drawState()` beim Export ausgewertet. Ein ausgewählter Spieler kann daher mit weißer Auswahlkontur in PNG oder GIF erscheinen.
- Die Frame-Anzeige ist für Menschen einsbasiert, interne Indizes und Challenge-Felder sind nullbasiert. Der Prompt für den Ziel-Frame erklärt diesen Unterschied nicht.
- Die öffentliche Teamübersicht lädt derzeit alle öffentlichen Teams ohne Pagination. Bei vielen Teams muss sie paginiert werden.
- Anonyme Benutzerkonten sind an die lokale Firebase-Auth-Persistenz gebunden. Eine spätere dauerhafte Anmeldung muss per `linkWithCredential` mit derselben UID verknüpft werden.
- App Check ist im Code noch nicht erzwungen. Erst Client konfigurieren, dann `enforceAppCheck` für Functions aktivieren.
- Die App hängt für GIF, Authentifizierung und Datenbankzugriff von externen CDNs beziehungsweise Firebase ab und besitzt keinen Offline-Modus.
- Der Landscape-Lock wird beim Laden versucht, Browser dürfen ihn jedoch außerhalb von Vollbild oder ohne Benutzeraktion ablehnen; der Fehler wird absichtlich ignoriert.
- Die Canvas-Berechnung reserviert 240 Pixel für eine 220 Pixel breite Sidebar. Layoutänderungen müssen beide Annahmen prüfen.

## Vorgehen für Änderungen

- Kleine, zielgerichtete Änderungen bevorzugen. Solange kein bewusster Refactor beauftragt ist, das statische Betriebsmodell ohne Build-Schritt erhalten.
- Vor Änderungen die betroffenen Inline-Bereiche in `index.html` vollständig lesen; UI, Zeichnung, Speicherung und Export teilen sich Daten und Funktionen.
- Bestehende gespeicherte Firestore-Dokumente als rückwärtskompatible Daten behandeln. Bei neuen Feldern sinnvolle Standardwerte für alte Dokumente vorsehen.
- Niemals Team-, Rollen- oder Passwortoperationen in den Client verschieben. Der Admin SDK darf Regeln umgehen; jede Function muss Authentifizierung, Rolle und Eingaben selbst prüfen.
- `teamSecrets`, `teamCodes` und `joinRateLimits` bleiben für alle Clients gesperrt. Passwörter nie loggen, zurückgeben oder in Teamdokumenten ablegen.
- Benutzereingaben aus Firestore nicht mit `innerHTML` einfügen. Der aktuelle Name wird so eingesetzt; neue Arbeit sollte stattdessen `textContent` verwenden und bestehende Stellen bei sicherheitsrelevanten Änderungen mitbetrachten.
- Keine produktiven Firestore-Daten für einen UI-Test schreiben, sofern das nicht ausdrücklich Teil der Aufgabe ist. Canvas-, PNG- und Challenge-Tests funktionieren lokal ohne Datenbankmutation.
- Personenbezogene Angaben in `impressum.html` und `datenschutz.html` nur auf ausdrücklichen Wunsch ändern.

## Manuelle Prüfung

Da es keine automatisierten Tests gibt, mindestens die direkt betroffenen Abläufe im Browser prüfen. Für größere Änderungen gehört dazu:

1. Seite per lokalem HTTP-Server laden; keine Fehler beim Laden von Spielfeld oder Scripts.
2. Spieler und Ball mit Maus sowie Touch/Touch-Emulation bewegen.
3. Alle drei Pfeilarten anlegen und visuell unterscheiden.
4. Spieler hinzufügen, Spieler/Ball löschen und Ball erneut setzen.
5. Mehrere Frames anlegen, wechseln, löschen und interpoliert abspielen.
6. Fenstergröße ändern und prüfen, ob Objekte relativ auf dem Feld bleiben.
7. PNG herunterladen und Bildinhalt kontrollieren.
8. GIF erzeugen, Fortschritt und heruntergeladene Animation prüfen.
9. Challenge-JSON herunterladen, parsen und normalisierte Koordinaten sowie Frame-Indizes kontrollieren.
10. Firestore-Speichern/-Laden nur bei verfügbarer Testberechtigung prüfen; dabei Browserkonsole und Netzwerkfehler beachten.
11. Vollbild, Werkzeugleisten-Schalter sowie Impressum-/Datenschutz-Navigation auf Desktop und schmalem Viewport prüfen.
12. Öffentliches und privates Team mit getrennten Benutzerprofilen testen; falsches/richtiges Passwort unterscheiden.
13. Spieler-Nur-Lesen-Modus und Adminfunktionen einschließlich Rollenwechsel, Kopieren und Löschen prüfen.
14. Vor Abschluss `npm test` sowie `npm --prefix functions test` ausführen.

Bei Änderungen am Datenmodell zusätzlich einen alten gespeicherten Zustand und einen neu erzeugten Zustand testen.
