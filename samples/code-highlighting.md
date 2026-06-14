# Code Highlighting Sample

Open this in Revenant and confirm each block is **syntax-colored** (not plain gray).
These are the 17 curated languages WS-3 registered. If any block you actually use
renders uncolored, tell me which language and I'll add it.

## TypeScript
```typescript
interface User { id: number; name: string; roles: Role[] }
const greet = async (u: User): Promise<string> => {
  const roles = u.roles.map((r) => r.label).join(", ");
  return `Hello ${u.name} (${roles})`;
};
```

## JavaScript
```javascript
export function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
```

## Rust
```rust
pub fn reanchor(ann: &Annotation, content: &str) -> Status {
    match probe_verbatim(ann, &content.lines().collect::<Vec<_>>()) {
        Some((s, e)) => Status::Anchored { start: s, end: e },
        None => Status::Detached,
    }
}
```

## Python
```python
from dataclasses import dataclass

@dataclass
class Annotation:
    line: int
    quoted: str

    def reanchor(self, doc: str) -> bool:
        return any(self.quoted in ln for ln in doc.splitlines())
```

## Go
```go
package main

import "fmt"

func Sum(xs []int) (total int) {
	for _, x := range xs {
		total += x
	}
	return
}

func main() { fmt.Println(Sum([]int{1, 2, 3})) }
```

## JSON
```json
{
  "schema_version": 1,
  "annotations": [
    { "id": "a1", "line_start": 4, "quoted_text": "Randy", "status": "anchored" }
  ]
}
```

## YAML
```yaml
build:
  beforeDevCommand: npm run dev
  devUrl: http://localhost:1420
plugins:
  - cli
  - dialog
```

## TOML
```toml
[package]
name = "revenant"
version = "0.1.0"

[dependencies]
fd-lock = "3"
```

## Bash
```bash
#!/usr/bin/env bash
set -euo pipefail
for f in *.md; do
  echo "rendering $f"
  revenant "$f" &
done
```

## SQL
```sql
SELECT u.name, COUNT(a.id) AS comments
FROM users u
LEFT JOIN annotations a ON a.author_id = u.id
WHERE a.status = 'anchored'
GROUP BY u.name
ORDER BY comments DESC;
```

## HTML (XML)
```html
<main class="app-root">
  <aside class="drawer" aria-label="Annotations">
    <button type="button">+ Add comment</button>
  </aside>
</main>
```

## CSS
```css
.composer {
  position: fixed;
  z-index: var(--z-pop);
  background: var(--surface);
  box-shadow: var(--shadow-pop);
}
.composer:focus-within { border-color: var(--accent); }
```

## C
```c
#include <stdio.h>

int factorial(int n) {
    return n <= 1 ? 1 : n * factorial(n - 1);
}

int main(void) { printf("%d\n", factorial(5)); return 0; }
```

## C++
```cpp
#include <vector>
#include <numeric>

template <typename T>
T sum(const std::vector<T>& xs) {
    return std::accumulate(xs.begin(), xs.end(), T{});
}
```

## Java
```java
public record Annotation(int line, String quoted, String status) {
    boolean isAnchored() { return "anchored".equals(status); }
}
```

## Dockerfile
```dockerfile
FROM rust:1.77 AS build
WORKDIR /app
COPY . .
RUN cargo build --release
ENTRYPOINT ["/app/target/release/revenant"]
```

## Diff
```diff
- if (lines[i] == quoted) {            // whole-line only
+ if (lines[i].contains(quoted)) {     // sub-line word selections
      mark_anchored(i);
  }
```

## Markdown (nested)
````markdown
# Title
- **bold** and _italic_
- `inline code`

> a blockquote
````
