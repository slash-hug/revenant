# Mermaid Diagrams Sample

Open this in Revenant (Preview or Split) and confirm each block renders as a
**diagram**, not as raw text. These are the diagram types WS-3 keeps; if any one
renders as plain code or an error box, tell me which.

## Flowchart
```mermaid
flowchart LR
  A[Local edit] --> B{Hash match?}
  B -- yes --> C[Write + bump version]
  B -- no --> D[Surface conflict]
  C --> E[(Sidecar)]
  D --> E
```

## Sequence
```mermaid
sequenceDiagram
  participant U as User
  participant R as Revenant
  participant A as Agent
  U->>R: Annotate the plan
  R->>R: Save sidecar + derive context
  U->>A: Generate review.md
  A-->>U: Address the notes
```

## Class
```mermaid
classDiagram
  class Annotation {
    +string id
    +int lineStart
    +string quotedText
    +reanchor(doc) Status
  }
  class Sidecar {
    +int schemaVersion
    +Annotation[] annotations
  }
  Sidecar "1" o-- "*" Annotation
```

## State
```mermaid
stateDiagram-v2
  [*] --> Anchored
  Anchored --> Detached: text deleted
  Detached --> Anchored: re-anchored on reload
  Anchored --> [*]
```

## Entity Relationship
```mermaid
erDiagram
  USER ||--o{ ANNOTATION : writes
  DOCUMENT ||--o{ ANNOTATION : "anchored in"
  USER {
    int id
    string name
  }
  ANNOTATION {
    string id
    int line_start
    string status
  }
```

## Gantt
```mermaid
gantt
  title Revenant v1.1 Hardening
  dateFormat  YYYY-MM-DD
  section Re-anchoring
  Wire context + load   :done, w1, 2026-06-14, 1d
  section Data integrity
  fd-lock + save chain  :done, w2, 2026-06-14, 1d
  section Perf
  hljs + mermaid trim   :active, w3, 2026-06-14, 1d
```

## Pie
```mermaid
pie title Bundle after WS-3
  "main app" : 750
  "mermaid (lazy)" : 655
  "cytoscape (lazy)" : 443
  "katex (lazy)" : 261
  "hljs (trimmed)" : 87
```

## Git Graph
```mermaid
gitGraph
  commit id: "spec"
  commit id: "plan"
  branch feat
  checkout feat
  commit id: "WS-1+2"
  commit id: "WS-3"
  commit id: "fixes"
  checkout main
  merge feat
```
