export function Pagination({
  page,
  onChange,
}: {
  page: number;
  onChange: (p: number) => void;
}) {
  return (
    <nav data-component="Pagination" className="pagination">
      <button disabled={page <= 1} onClick={() => onChange(page - 1)}>
        前へ
      </button>
      <span>{page}</span>
      <button onClick={() => onChange(page + 1)}>次へ</button>
    </nav>
  );
}
