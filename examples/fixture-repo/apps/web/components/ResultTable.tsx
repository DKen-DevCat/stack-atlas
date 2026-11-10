import type { RaceResult } from "@race/types";

function Row({ rank, runner, time }: RaceResult) {
  return (
    <tr>
      <td>{rank}</td>
      <td>{runner}</td>
      <td>{time}</td>
    </tr>
  );
}

export function ResultTable({
  results,
  editable,
}: {
  results: RaceResult[];
  editable?: boolean;
}) {
  return (
    <table data-component="ResultTable" data-editable={editable ? "true" : undefined}>
      <tbody>
        {results.map((r) => (
          <Row key={r.rank} {...r} />
        ))}
      </tbody>
    </table>
  );
}
