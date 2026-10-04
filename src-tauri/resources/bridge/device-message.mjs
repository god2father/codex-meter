// Optional status decoration must never make a valid approval unreadable.
export function encodeDeviceMessage(message) {
  const payload = { ...message };
  let wire = JSON.stringify(payload);
  if (Buffer.byteLength(wire) >= 4096 && payload.content !== undefined) { delete payload.content; wire = JSON.stringify(payload); }
  if (Buffer.byteLength(wire) >= 4096 && payload.messages !== undefined) { delete payload.messages; wire = JSON.stringify(payload); }
  if (Buffer.byteLength(wire) >= 4096) { payload.quota = null; wire = JSON.stringify(payload); }
  if (Buffer.byteLength(wire) >= 4096) { payload.threadTitle = ''; wire = JSON.stringify(payload); }
  return Buffer.byteLength(wire) < 4096 ? wire : null;
}
