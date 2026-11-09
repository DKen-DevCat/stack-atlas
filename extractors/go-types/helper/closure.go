package main

// host の閉包（docs/17 §7 #11）: 入口（cmd/* の main と -entry）から、呼び出し・関数の値の参照（HandleFunc に渡した
// handler など）・interface への変換（ListenAndServe に渡した値の ServeHTTP など）を辿り、各箱に届く入口を Reach に並べる。
// TS の側が入口 → インフラの箱（config の deploy.*.go と Lambda の推定）にして、1 つなら host、2 つ以上なら meta.hosts にする

import "sort"

func (a *analyzer) closure() {
	next := func(b *Box) []*Box {
		var out []*Box
		for _, ev := range b.calls {
			out = append(out, ev.callee)
		}
		out = append(out, b.refs...)
		out = append(out, b.dyn...)
		return out
	}
	reach := map[*Box]map[string]bool{}
	for _, e := range a.boxes {
		if e.Entry == "" {
			continue
		}
		seen := map[*Box]bool{e: true}
		queue := []*Box{e}
		for len(queue) > 0 {
			b := queue[0]
			queue = queue[1:]
			if reach[b] == nil {
				reach[b] = map[string]bool{}
			}
			reach[b][e.Entry] = true
			for _, n := range next(b) {
				if !seen[n] {
					seen[n] = true
					queue = append(queue, n)
				}
			}
		}
	}
	for _, b := range a.boxes {
		for e := range reach[b] {
			b.Reach = append(b.Reach, e)
		}
		sort.Strings(b.Reach)
	}
}
