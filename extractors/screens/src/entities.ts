/**
 * HTML の文字参照（`&amp;` `&#x6A;` `&#106;`）を解く。
 *
 * 名前付きの参照は HTML4 の全部と、URL の判定に効く HTML5 の記号（`&colon;` `&Tab;` `&NewLine;` `&lpar;` など）だけを持つ。
 * 知らない名前は解かずに文字のまま残す。消毒した HTML は解いた後の文字列を書き直す（`&` は `&amp;` にする）ので、
 * ブラウザが見る値は、ここで判定した値と同じになる（知らない名前で判定をすり抜けることは無い。見た目が少し変わるだけ）。
 */

const NAMED_LIST = `
quot 34 amp 38 apos 39 lt 60 gt 62 nbsp 160 iexcl 161 cent 162 pound 163 curren 164 yen 165 brvbar 166 sect 167 uml 168
copy 169 ordf 170 laquo 171 not 172 shy 173 reg 174 macr 175 deg 176 plusmn 177 sup2 178 sup3 179 acute 180 micro 181
para 182 middot 183 cedil 184 sup1 185 ordm 186 raquo 187 frac14 188 frac12 189 frac34 190 iquest 191 Agrave 192
Aacute 193 Acirc 194 Atilde 195 Auml 196 Aring 197 AElig 198 Ccedil 199 Egrave 200 Eacute 201 Ecirc 202 Euml 203
Igrave 204 Iacute 205 Icirc 206 Iuml 207 ETH 208 Ntilde 209 Ograve 210 Oacute 211 Ocirc 212 Otilde 213 Ouml 214
times 215 Oslash 216 Ugrave 217 Uacute 218 Ucirc 219 Uuml 220 Yacute 221 THORN 222 szlig 223 agrave 224 aacute 225
acirc 226 atilde 227 auml 228 aring 229 aelig 230 ccedil 231 egrave 232 eacute 233 ecirc 234 euml 235 igrave 236
iacute 237 icirc 238 iuml 239 eth 240 ntilde 241 ograve 242 oacute 243 ocirc 244 otilde 245 ouml 246 divide 247
oslash 248 ugrave 249 uacute 250 ucirc 251 uuml 252 yacute 253 thorn 254 yuml 255 OElig 338 oelig 339 Scaron 352
scaron 353 Yuml 376 fnof 402 circ 710 tilde 732 Alpha 913 Beta 914 Gamma 915 Delta 916 Epsilon 917 Zeta 918 Eta 919
Theta 920 Iota 921 Kappa 922 Lambda 923 Mu 924 Nu 925 Xi 926 Omicron 927 Pi 928 Rho 929 Sigma 931 Tau 932 Upsilon 933
Phi 934 Chi 935 Psi 936 Omega 937 alpha 945 beta 946 gamma 947 delta 948 epsilon 949 zeta 950 eta 951 theta 952
iota 953 kappa 954 lambda 955 mu 956 nu 957 xi 958 omicron 959 pi 960 rho 961 sigmaf 962 sigma 963 tau 964
upsilon 965 phi 966 chi 967 psi 968 omega 969 thetasym 977 upsih 978 piv 982 ensp 8194 emsp 8195 thinsp 8201
zwnj 8204 zwj 8205 lrm 8206 rlm 8207 ndash 8211 mdash 8212 lsquo 8216 rsquo 8217 sbquo 8218 ldquo 8220 rdquo 8221
bdquo 8222 dagger 8224 Dagger 8225 bull 8226 hellip 8230 permil 8240 prime 8242 Prime 8243 lsaquo 8249 rsaquo 8250
oline 8254 frasl 8260 euro 8364 image 8465 weierp 8472 real 8476 trade 8482 alefsym 8501 larr 8592 uarr 8593
rarr 8594 darr 8595 harr 8596 crarr 8629 lArr 8656 uArr 8657 rArr 8658 dArr 8659 hArr 8660 forall 8704 part 8706
exist 8707 empty 8709 nabla 8711 isin 8712 notin 8713 ni 8715 prod 8719 sum 8721 minus 8722 lowast 8727 radic 8730
prop 8733 infin 8734 ang 8736 and 8743 or 8744 cap 8745 cup 8746 int 8747 there4 8756 sim 8764 cong 8773 asymp 8776
ne 8800 equiv 8801 le 8804 ge 8805 sub 8834 sup 8835 nsub 8836 sube 8838 supe 8839 oplus 8853 otimes 8855 perp 8869
sdot 8901 lceil 8968 rceil 8969 lfloor 8970 rfloor 8971 lang 10216 rang 10217 loz 9674 spades 9824 clubs 9827
hearts 9829 diams 9830
Tab 9 NewLine 10 excl 33 num 35 dollar 36 percnt 37 lpar 40 rpar 41 ast 42 plus 43 comma 44 period 46 sol 47
colon 58 semi 59 equals 61 quest 63 commat 64 lsqb 91 lbrack 91 bsol 92 rsqb 93 rbrack 93 Hat 94 lowbar 95 grave 96
lcub 123 lbrace 123 verbar 124 vert 124 VerticalLine 124 rcub 125 rbrace 125 hyphen 8208 dash 8208
`;

/** 名前 → 文字 */
export const NAMED: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  const parts = NAMED_LIST.trim().split(/\s+/);
  for (let i = 0; i + 1 < parts.length; i += 2)
    m.set(parts[i]!, String.fromCodePoint(Number(parts[i + 1])));
  return m;
})();

/** `&#x80;`〜`&#x9F;` は Windows-1252 として読む（HTML の仕様） */
const C1: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};

/** 数値の参照の値 → 文字（0・サロゲート・範囲外は U+FFFD、C1 は Windows-1252） */
export function codePointToString(cp: number): string {
  if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
    return '\uFFFD';
  return String.fromCodePoint(C1[cp] ?? cp);
}

const REF = /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]{0,31});)/g;

/** 文字参照を解く。知らない名前付きの参照（`&foo;`）はそのまま残す */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(REF, (m, hex?: string, dec?: string, name?: string) => {
    // 桁が多すぎるものは範囲外（U+FFFD）。parseInt の精度に頼らない
    if (hex !== undefined)
      return codePointToString(hex.replace(/^0+/, '').length > 6 ? Infinity : parseInt(hex, 16));
    if (dec !== undefined)
      return codePointToString(dec.replace(/^0+/, '').length > 7 ? Infinity : parseInt(dec, 10));
    return NAMED.get(name!) ?? m;
  });
}
