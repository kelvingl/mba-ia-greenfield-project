/** Characters that could break the quoted filename or the header itself. */
const UNSAFE = /["\\/]|\p{Cc}/gu;
const NON_ASCII = /[^\x20-\x7e]/g;

/**
 * `Content-Disposition` value that makes the browser download a file named
 * after the video title. Quotes, backslashes, path separators and control
 * characters are removed so the title cannot escape the header; a title with
 * non-ASCII characters also gets an RFC 5987 `filename*` with the real name.
 */
export function attachmentDisposition(
  title: string,
  extension: string,
): string {
  const name = `${title.replace(UNSAFE, '').trim() || 'video'}${extension}`;
  const ascii = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(NON_ASCII, '_');
  if (ascii === name) return `attachment; filename="${name}"`;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
