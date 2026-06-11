# slot-text

> Dependency-free text roll animation for tiny, tactile UI labels. Pure CSS transforms, no runtime dependencies. Browser-only DOM utility. Works best on short labels, buttons, counters, and command text.

## Install

```bash
npm install slot-text
```

Import the CSS once before using the animation: `import "slot-text/style.css";`

## Usage: Vanilla

```ts
import "slot-text/style.css";
import { slotText, chromatic } from "slot-text";

const label = slotText(document.querySelector("#copy"), "Copy");
label.set("Copied", { direction: "up", color: chromatic() });
label.set("Copy", { direction: "down" });
label.destroy();
```

## Usage: React

```tsx
import "slot-text/style.css";
import { SlotText } from "slot-text/react";
import { chromatic } from "slot-text";

<SlotText
  text={copied ? "Copied" : "Copy"}
  options={{
    direction: copied ? "up" : "down",
    skipUnchanged: false,
    color: copied ? chromatic() : undefined,
  }}
/>
```

## Usage: Vue

```vue
<script setup lang="ts">
import "slot-text/style.css";
import { SlotText } from "slot-text/vue";
import { chromatic } from "slot-text";

const options = { direction: "up", skipUnchanged: false, color: chromatic() } as const;
</script>

<template>
  <SlotText text="Copied" :options="options" />
</template>
```

## API

- `slotText(element, text, options?)` — vanilla controller with `.set(text, options?)`, `.flash(text, options?)`, and `.destroy()`
- `SlotText` component from `slot-text/react` and `slot-text/vue` (optional peer deps; plain JS users do not need them)
- Low-level helpers: `buildSlotText`, `animateSlotText`, `chromatic` from `slot-text`

## Options

```ts
type SlotOptions = {
  direction?: "up" | "down";       // default "down"
  stagger?: number;                // default 45
  duration?: number;               // default 300
  exitOffset?: number;             // default 50
  easing?: string;                 // default "cubic-bezier(0.34, 1.56, 0.64, 1)"
  bounce?: number;                 // default 0.6
  color?: string | ((index: number, total: number) => string);
  colorFade?: number;              // default 280
  skipUnchanged?: boolean;         // default true
  interrupt?: boolean;             // default true
};
```
