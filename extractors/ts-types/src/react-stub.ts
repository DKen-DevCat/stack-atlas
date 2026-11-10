/**
 * react の型が解けない（node_modules が無い）ときだけ足す最小の型の stub（docs/17 §7 #10）。
 * 部品の判定は構文で行うので、stub が要るのは useState の型（state を経由する links の型と、`if (!view) return` の
 * 絞り込み）と JSX の名前空間（React 19 にはグローバルの JSX が無い）だけ。実リポジトリでは @types/react を使う
 */
import { ts, type Project } from 'ts-morph';

/** stub を置く仮想のパス（repo の外。項目の展開・typeRef の対象にしない） */
export const REACT_STUB_PATH = '/__stack-atlas__/react-stub.d.ts';

export const REACT_STUB = `// Stack Atlas ts-types: react の型が解けないときの最小の stub
declare namespace JSX {
  interface Element {}
  interface ElementClass {}
  interface ElementAttributesProperty { props: {} }
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicAttributes { key?: string | number | null }
  interface IntrinsicElements { [tag: string]: any }
}
declare module 'react' {
  export type ReactNode = JSX.Element | string | number | boolean | null | undefined | ReactNode[];
  export type ReactElement = JSX.Element;
  export type FC<P = {}> = (props: P) => JSX.Element | null;
  export type Dispatch<A> = (value: A) => void;
  export type SetStateAction<S> = S | ((prev: S) => S);
  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
  export function useReducer<S, A>(reducer: (s: S, a: A) => S, initial: S): [S, Dispatch<A>];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useCallback<T>(cb: T, deps: readonly unknown[]): T;
  export function useRef<T>(initial: T): { current: T };
  export interface Context<T> { Provider: (props: { value: T; children?: ReactNode }) => JSX.Element }
  export function createContext<T>(defaultValue: T): Context<T>;
  export function useContext<T>(ctx: Context<T>): T;
  export function memo<P>(c: (props: P) => JSX.Element | null): (props: P) => JSX.Element | null;
  export function forwardRef<T, P>(c: (props: P, ref: unknown) => JSX.Element | null): (props: P) => JSX.Element | null;
  export const Fragment: (props: { children?: ReactNode }) => JSX.Element;
}
declare module 'react/jsx-runtime' {
  export const jsx: (...args: unknown[]) => JSX.Element;
  export const jsxs: (...args: unknown[]) => JSX.Element;
  export const Fragment: unknown;
}
`;

/**
 * Project の中で react が解けず、JSX（.tsx）か react の import があるなら stub を足す。足したら true
 */
export function ensureReactTypes(project: Project, files: readonly string[]): boolean {
  if (project.getSourceFile(REACT_STUB_PATH)) return false;
  const tsx = files.find((f) => /\.[jt]sx$/.test(f));
  const anyFile = tsx ?? files[0];
  if (!anyFile) return false;
  const usesReact =
    !!tsx ||
    files.some((f) =>
      project
        .getSourceFile(f)
        ?.getImportDeclarations()
        .some((i) => i.getModuleSpecifierValue() === 'react'),
    );
  if (!usesReact) return false;
  const resolved = ts.resolveModuleName(
    'react',
    anyFile,
    project.getCompilerOptions(),
    ts.sys,
  ).resolvedModule;
  if (resolved) return false;
  project.createSourceFile(REACT_STUB_PATH, REACT_STUB, { overwrite: true });
  return true;
}
