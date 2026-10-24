"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createPasswordRecord, randomCode, verifyPassword } = require("../passwords");

test("Passwörter werden gesalzen gehasht und konstant geprüft", async () => {
  const password = "Sicheres Team-Passwort 42!";
  const first = await createPasswordRecord(password);
  const second = await createPasswordRecord(password);

  assert.equal(first.algorithm, "scrypt");
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(JSON.stringify(first).includes(password), false);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("falsch", first), false);
});

test("Teamcodes enthalten nur gut unterscheidbare Großbuchstaben und Ziffern", () => {
  const codes = new Set(Array.from({ length: 100 }, () => randomCode()));
  assert.equal(codes.size, 100);
  for (const code of codes) assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/);
});
