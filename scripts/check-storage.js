// Proves that message files work with the real Cloudinary account from .env:
// asks for a ticket, uploads a tiny file with it like the browser does, checks the receipt,
// loads the file back and deletes it again. Run with: npm run check:storage
import "dotenv/config";

const { createUploadTicket, deleteUpload, verifyUpload } = await import("../lib/storage.js");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const SAMPLES = [
  ["image", "check.png", "image/png", PNG],
  ["file", "check.txt", "text/plain", Buffer.from("storage check")],
];

let failed = false;
for (const [kind, name, type, body] of SAMPLES) {
  try {
    const ticket = createUploadTicket(kind, "");
    const form = new FormData();
    Object.entries(ticket.fields).forEach(([key, value]) => form.append(key, String(value)));
    form.append("file", new Blob([body], { type }), name);

    const response = await fetch(ticket.url, { method: "POST", body: form });
    const receipt = await response.json();
    if (!response.ok) throw new Error(`upload refused: ${receipt.error?.message || response.status}`);

    const asset = await verifyUpload(kind, receipt, "");
    const loaded = await fetch(asset.url);
    await deleteUpload(asset);
    if (!loaded.ok) throw new Error(`uploaded, but the link answers ${loaded.status}`);

    console.log(`ok    ${kind}: uploaded, verified, loaded and deleted`);
  } catch (error) {
    failed = true;
    console.log(`FAIL  ${kind}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
