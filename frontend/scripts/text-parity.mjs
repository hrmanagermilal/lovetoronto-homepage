import { load } from 'cheerio';
import crypto from 'node:crypto';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export function textEvidence(html) {
  const $ = load(html, { scriptingEnabled: false });
  $('script,style,link,meta,base').remove();
  $('noscript').each((_, element) => $(element).replaceWith($(element).contents()));
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const attributes = [];
  $('[alt],[title],[placeholder],input[value],button[value],option').each((_, element) => {
    for (const name of ['alt', 'title', 'placeholder', 'value']) {
      if (name === 'value' && ['hidden', 'checkbox', 'radio'].includes($(element).attr('type'))) continue;
      if (name === 'value' && !['input', 'button', 'option'].includes(element.tagName)) continue;
      const value = $(element).attr(name);
      if (value) attributes.push(`${element.tagName}:${name}:${value}`);
    }
  });
  return { text, textSha256: sha(text), characters: text.length, attributes, attributeSha256: sha(JSON.stringify(attributes)) };
}
export function comparePage(source, output, id) {
  const before = textEvidence(source);
  const after = textEvidence(output);
  if (before.text !== after.text) {
    let offset = 0;
    while (offset < before.text.length && before.text[offset] === after.text[offset]) offset++;
    throw new Error(`Page wording differs: ${id}, offset ${offset}\nSOURCE: ${before.text.slice(Math.max(0, offset - 70), offset + 140)}\nOUTPUT: ${after.text.slice(Math.max(0, offset - 70), offset + 140)}`);
  }
  if (JSON.stringify(before.attributes) !== JSON.stringify(after.attributes)) {
    throw new Error(`Page labels differ: ${id}\n${JSON.stringify(before.attributes.filter((value, index) => value !== after.attributes[index]).slice(0, 6))}`);
  }
  return { file: id, characters: before.characters, textSha256: before.textSha256, attributeSha256: before.attributeSha256, exactText: true, exactLabels: true };
}
