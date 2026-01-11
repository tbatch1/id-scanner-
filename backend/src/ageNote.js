"use strict";

function coerceAgeNumber(age) {
  const parsed = Number.parseInt(age, 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0 || parsed > 130) return null;
  return parsed;
}

function buildAgeNoteLine(age) {
  const ageNumber = coerceAgeNumber(age);
  if (!Number.isFinite(ageNumber)) return null;
  return `Age: ${ageNumber}`;
}

function stripRawScanFromNote(note) {
  const text = String(note || '');
  if (!text) return '';
  const ansiIndex = text.indexOf('@ANSI');
  const aimIndex = text.indexOf(']L');
  const markerIndex = ansiIndex >= 0 ? ansiIndex : (aimIndex >= 0 ? aimIndex : -1);
  if (markerIndex >= 0) return text.slice(0, markerIndex).trimEnd();
  return text;
}

function appendAgeNote(existingNote, age) {
  const ageLine = buildAgeNoteLine(age);
  if (!ageLine) return stripRawScanFromNote(existingNote);

  const cleaned = stripRawScanFromNote(existingNote);
  const lines = String(cleaned || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const lastLine = lines.length ? lines[lines.length - 1].trim() : '';
  if (lastLine === ageLine) return lines.join('\n');
  return [...lines, ageLine].join('\n');
}

function parseAgeNote(existingNote) {
  const raw = String(existingNote || '');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const mostRecentAge = [...lines].reverse().find((line) => /^Age:\s*/i.test(line)) || null;
  if (!mostRecentAge) return { hasAgeNote: false, age: null, line: null };
  const match = mostRecentAge.match(/Age:\s*(\d{1,3})/i);
  const age = match ? Number.parseInt(match[1], 10) : null;
  return { hasAgeNote: true, age: Number.isFinite(age) ? age : null, line: mostRecentAge };
}

module.exports = {
  buildAgeNoteLine,
  appendAgeNote,
  parseAgeNote
};

