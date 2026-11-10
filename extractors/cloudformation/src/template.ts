/**
 * テンプレートの読み込み（JSON / YAML。YAML は CFn の短縮形 `!Ref` `!GetAtt` `!Sub` `!Join` … を解釈）
 */
import { parse as parseYaml, type CollectionTag, type ScalarTag } from 'yaml';

const FUNCTIONS = [
  'Ref',
  'GetAtt',
  'Sub',
  'Join',
  'If',
  'Select',
  'Split',
  'FindInMap',
  'ImportValue',
  'GetAZs',
  'Base64',
  'Equals',
  'Not',
  'And',
  'Or',
  'Condition',
  'Cidr',
  'Transform',
  'Length',
  'ToJsonString',
];

const keyOf = (f: string) => (f === 'Ref' || f === 'Condition' ? f : `Fn::${f}`);

export const CFN_TAGS: Array<ScalarTag | CollectionTag> = FUNCTIONS.flatMap((f) => [
  {
    tag: `!${f}`,
    resolve: (s: string) => ({ [keyOf(f)]: f === 'GetAtt' ? s.split('.') : s }),
  } as ScalarTag,
  {
    tag: `!${f}`,
    collection: 'seq',
    resolve: (v: { toJSON(): unknown }) => ({ [keyOf(f)]: v.toJSON() }),
  } as unknown as CollectionTag,
  {
    tag: `!${f}`,
    collection: 'map',
    resolve: (v: { toJSON(): unknown }) => ({ [keyOf(f)]: v.toJSON() }),
  } as unknown as CollectionTag,
]);

export function parseTemplate(file: string, text: string): unknown {
  if (file.endsWith('.json')) return JSON.parse(text);
  return parseYaml(text, { customTags: CFN_TAGS, logLevel: 'error', uniqueKeys: false });
}

/** テンプレートらしいか（Resources か AWSTemplateFormatVersion を持つ） */
export const looksLikeTemplate = (text: string): boolean =>
  /(^|["\s])AWSTemplateFormatVersion["\s]*:/m.test(text) || /(^|")Resources"?\s*:/m.test(text);
