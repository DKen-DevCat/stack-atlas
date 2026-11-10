/** DynamoDB の単一テーブル設計（テーブル名は環境変数 TABLE） */
export type RaceItem = {
  pk: string; // RACE#<id>
  sk: string; // META | RESULT#<rank>
  name?: string;
  date?: string;
  venue?: string;
  runner?: string;
  time?: string;
};
