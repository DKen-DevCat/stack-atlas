export const dynamic = 'force-static';
export function generateStaticParams() {
  return [{ id: '1' }];
}
export default function Item() {
  return <main>item</main>;
}
