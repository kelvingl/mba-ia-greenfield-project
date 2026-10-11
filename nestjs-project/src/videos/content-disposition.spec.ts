import { attachmentDisposition } from './content-disposition';

describe('attachmentDisposition', () => {
  it('should name the file after the title and keep the extension', () => {
    expect(attachmentDisposition('Minha aula', '.mp4')).toBe(
      'attachment; filename="Minha aula.mp4"',
    );
  });

  it('should strip quotes, backslashes, path separators and line breaks', () => {
    const value = attachmentDisposition('a"b\\c/d\r\ne\u0000f', '.mp4');

    expect(value).toBe('attachment; filename="abcdef.mp4"');
    expect(value).not.toMatch(/[\r\n]/);
  });

  it('should add an RFC 5987 name when the title has non-ASCII characters', () => {
    expect(attachmentDisposition('Introdução ao Nest', '.mp4')).toBe(
      `attachment; filename="Introducao ao Nest.mp4"; filename*=UTF-8''Introdu%C3%A7%C3%A3o%20ao%20Nest.mp4`,
    );
  });

  it('should fall back to a generic name when nothing safe is left', () => {
    expect(attachmentDisposition('"/\\', '.webm')).toBe(
      'attachment; filename="video.webm"',
    );
  });
});
