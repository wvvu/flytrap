/** Header block only. The body after the blank line is not returned. */
export function rfc822HeaderBlock(bytes: Buffer): string {
  const crlf = bytes.indexOf("\r\n\r\n");
  const lf = bytes.indexOf("\n\n");
  let end = bytes.length;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) end = crlf;
  else if (lf >= 0) end = lf;
  if (end > 256 * 1024) end = 256 * 1024;
  return bytes.subarray(0, end).toString("latin1");
}
