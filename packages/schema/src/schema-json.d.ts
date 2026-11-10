// graph.schema.json は src/ の外にあるため resolveJsonModule を使わず、ここで型を宣言する
declare module '*/graph.schema.json' {
  const schema: Record<string, unknown>;
  export default schema;
}
