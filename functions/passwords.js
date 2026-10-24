"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PASSWORD_BYTES = 64;

function randomCode(length = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(length);
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
}

async function createPasswordRecord(password, updatedAt = null) {
  const salt = crypto.randomBytes(16);
  const normalized = String(password).normalize("NFKC");
  const derived = await scrypt(normalized, salt, PASSWORD_BYTES, SCRYPT_OPTIONS);
  return {
    algorithm: "scrypt",
    salt: salt.toString("hex"),
    hash: derived.toString("hex"),
    parameters: {
      N: SCRYPT_OPTIONS.N,
      r: SCRYPT_OPTIONS.r,
      p: SCRYPT_OPTIONS.p,
      keyLength: PASSWORD_BYTES
    },
    updatedAt
  };
}

async function verifyPassword(password, record) {
  if (!record || record.algorithm !== "scrypt" || !record.salt || !record.hash) return false;
  const supplied = typeof password === "string" ? password.normalize("NFKC") : "";
  const expected = Buffer.from(record.hash, "hex");
  if (expected.length !== PASSWORD_BYTES) return false;
  const actual = await scrypt(supplied, Buffer.from(record.salt, "hex"), expected.length, {
    N: record.parameters?.N || SCRYPT_OPTIONS.N,
    r: record.parameters?.r || SCRYPT_OPTIONS.r,
    p: record.parameters?.p || SCRYPT_OPTIONS.p,
    maxmem: SCRYPT_OPTIONS.maxmem
  });
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { createPasswordRecord, randomCode, verifyPassword };
