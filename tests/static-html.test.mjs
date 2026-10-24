import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { parse } from "parse5";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

function walk(node, visitor) {
  visitor(node);
  for (const child of node.childNodes || []) walk(child, visitor);
}

test("index.html ist strukturell parsebar und verwendet eindeutige IDs", () => {
  const parseErrors = [];
  const document = parse(html, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parseErrors.push(error)
  });
  assert.deepEqual(parseErrors, []);

  const ids = new Map();
  walk(document, (node) => {
    const id = node.attrs?.find((attribute) => attribute.name === "id")?.value;
    if (!id) return;
    assert.equal(ids.has(id), false, `Doppelte HTML-ID: ${id}`);
    ids.set(id, node.nodeName);
  });

  for (const required of ["field", "sidebar", "team-modal", "team-list", "tactic-list", "member-list"]) {
    assert.equal(ids.has(required), true, `Erforderliches Element fehlt: ${required}`);
  }
});

test("das klassische Inline-Script ist syntaktisch gültig", () => {
  const document = parse(html);
  const scripts = [];
  walk(document, (node) => {
    if (node.nodeName !== "script") return;
    const attributes = new Map((node.attrs || []).map((attribute) => [attribute.name, attribute.value]));
    if (!attributes.has("src") && attributes.get("type") !== "module") {
      scripts.push((node.childNodes || []).map((child) => child.value || "").join(""));
    }
  });
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: "index.html:inline.js" }));
});

test("lokale Laufzeit-Assets sind vorhanden", () => {
  for (const file of [
    "team-management.js",
    "gif.worker.js",
    "bilder_webp_Spielzüge_Rollhockey Spielfeld.png",
    "impressum.html",
    "datenschutz.html"
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `Asset fehlt: ${file}`);
  }
});
