// Document attachments for licences.
//
// Files are stored in Firestore itself (not Cloud Storage), because Cloud
// Storage needs a paid Firebase plan and this project is on the free one.
// A Firestore document is capped at 1 MiB, so each file is cut into
// ~700 KB pieces:
//   licenseDocs/{id}              — one small metadata doc per file (name,
//                                    size, who/when, how many pieces)
//   licenseDocChunks/{id}_{index} — the pieces themselves, as raw bytes
// Pieces are written first and the metadata doc last, so a half-uploaded
// file never shows up in a list. Documents live in their own collections
// and are only fetched on demand, so they never slow down the records
// that the dashboard keeps live.
import {
  collection, doc, setDoc, getDoc, deleteDoc, onSnapshot, serverTimestamp, Bytes
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { currentUser } from "./auth.js";
import { logAction } from "./audit.js";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;   // per file
const CHUNK_BYTES = 700 * 1024;                  // raw bytes per piece (limit is 1 MiB per document)

// Allowed types, and the MIME type each is served back as. The type is
// taken from the file extension — never from what the browser claims — so
// an upload can't pass itself off as something that would run in a tab.
export const ALLOWED_TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
// Safe to open in a browser tab (PDF + plain images); the rest download.
export const VIEWABLE = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp']);

export function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

// Pure helpers (exported so they can be tested without a database).
export function splitBytes(bytes, size = CHUNK_BYTES) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += size) parts.push(bytes.subarray(i, Math.min(i + size, bytes.length)));
  return parts.length ? parts : [new Uint8Array(0)];
}
export function joinBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  parts.forEach(p => { out.set(p, off); off += p.length; });
  return out;
}

export function subscribeLicenseDocs(callback) {
  return onSnapshot(collection(db, 'licenseDocs'), (snap) => {
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    callback(rows);
  });
}

// Returns an error message if the file can't be attached, otherwise null.
export function checkFile(file) {
  const ext = extOf(file.name);
  if (!ALLOWED_TYPES[ext]) return `"${file.name}": only PDF, image (JPG/PNG/WEBP), Word and Excel files can be attached.`;
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > MAX_FILE_BYTES) return `"${file.name}" is ${(file.size / 1048576).toFixed(1)} MB — the limit is ${MAX_FILE_BYTES / 1048576} MB per file.`;
  return null;
}

export async function attachLicenseDocument(licenseId, licenseSummary, file, onProgress) {
  const problem = checkFile(file);
  if (problem) throw new Error(problem);
  const ext = extOf(file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parts = splitBytes(bytes);
  const metaRef = doc(collection(db, 'licenseDocs'));   // id reserved up front, written last
  const written = [];
  try {
    for (let i = 0; i < parts.length; i++) {
      const ref = doc(db, 'licenseDocChunks', `${metaRef.id}_${i}`);
      await setDoc(ref, { docId: metaRef.id, index: i, data: Bytes.fromUint8Array(parts[i]) });
      written.push(ref);
      if (onProgress) onProgress(i + 1, parts.length);
    }
    await setDoc(metaRef, {
      licenseId, name: file.name, ext, size: bytes.length, chunks: parts.length,
      uploadedBy: currentUser?.name || 'Unknown', uploadedAt: serverTimestamp(),
    });
  } catch (e) {
    // Don't leave orphaned pieces behind if the upload failed part-way.
    await Promise.allSettled(written.map(r => deleteDoc(r)));
    throw e;
  }
  await logAction({
    action: 'Create', recordType: 'license-document', recordId: metaRef.id,
    recordSummary: `${file.name} → ${licenseSummary}`, previousValue: null, newValue: { name: file.name, size: bytes.length },
  });
  return metaRef.id;
}

// Reassembles a stored file into a Blob, typed from its extension.
export async function fetchLicenseDocumentBlob(meta) {
  const snaps = await Promise.all(
    Array.from({ length: meta.chunks }, (_, i) => getDoc(doc(db, 'licenseDocChunks', `${meta.id}_${i}`)))
  );
  const parts = snaps.map((s, i) => {
    if (!s.exists()) throw new Error(`"${meta.name}" is incomplete (part ${i + 1} of ${meta.chunks} is missing).`);
    return s.data().data.toUint8Array();
  });
  return new Blob([joinBytes(parts)], { type: ALLOWED_TYPES[meta.ext] || 'application/octet-stream' });
}

export async function deleteLicenseDocument(meta, licenseSummary) {
  await deleteDoc(doc(db, 'licenseDocs', meta.id));   // metadata first, so it leaves the list immediately
  await Promise.allSettled(Array.from({ length: meta.chunks }, (_, i) => deleteDoc(doc(db, 'licenseDocChunks', `${meta.id}_${i}`))));
  await logAction({
    action: 'Delete', recordType: 'license-document', recordId: meta.id,
    recordSummary: `${meta.name} ← ${licenseSummary}`, previousValue: { name: meta.name, size: meta.size }, newValue: null,
  });
}
