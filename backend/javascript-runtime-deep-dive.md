# JavaScript Runtime Deep Dive

# Table of Contents

1. Hoisting
2. TDZ (Temporal Dead Zone)
3. Execution Context
4. Scope & Scope Chain
5. Closures
6. Stack vs Heap
7. Garbage Collection
8. Memory Leaks
9. Event Loop
10. Microtasks vs Macrotasks
11. Rendering Pipeline
12. Lazy Parsing & Lazy Compilation
13. Async/Await Internals
14. Race Conditions
15. Senior-Level Mental Models

---

# 1. Hoisting

JavaScript runs code in two major phases:

```txt
1. Creation Phase
2. Execution Phase
```

During the Creation Phase:

- Functions are allocated in memory
- `var` variables are initialized with `undefined`
- `let` and `const` are hoisted but remain uninitialized (TDZ)

---

## Function Hoisting

```js
sayHi();

function sayHi() {
  console.log("hi");
}
```

Works because the entire function is allocated during creation.

---

## var Hoisting

```js
console.log(x);

var x = 5;
```

Internally behaves like:

```js
var x = undefined;

console.log(x);

x = 5;
```

Output:

```txt
undefined
```

---

# 2. TDZ — Temporal Dead Zone

TDZ is the time between:

- entering scope
- and variable initialization

during which the variable exists but cannot be accessed.

---

## Example

```js
console.log(a);

let a = 10;
```

Output:

```txt
ReferenceError
```

---

## Why?

Because `let` and `const` are:

```txt
Hoisted
BUT
Uninitialized
```

---

## Visualization

```js
{
  // TDZ START

  console.log(x);

  let x = 1;

  // TDZ END
}
```

---

# var vs let/const

| Keyword | Hoisted | Initialized |
| ------- | ------- | ----------- |
| var     | Yes     | undefined   |
| let     | Yes     | No          |
| const   | Yes     | No          |

---

# 3. Execution Context

Every function invocation creates a new execution context.

Each context contains:

- variables
- scope references
- `this`
- lexical environment

---

## Example

```js
function one() {
  let a = 1;
  two();
}

function two() {
  let b = 2;
}

one();
```

---

## Call Stack

```txt
Global
↓
one
↓
two
```

---

# 4. Scope & Scope Chain

Scope determines where variables are accessible.

---

## Global Scope

```js
let name = "Dan";
```

Accessible everywhere.

---

## Function Scope

```js
function test() {
  let age = 20;
}
```

`age` only exists inside the function.

---

## Block Scope

```js
if (true) {
  let x = 1;
}
```

`x` only exists inside the block.

---

# Lexical Scope

Scope is determined by where code is written.

---

## Example

```js
let a = 1;

function x() {
  console.log(a);
}

function y() {
  let a = 2;
  x();
}

y();
```

Output:

```txt
1
```

Because `x` was created in global scope.

---

# 5. Closures

A closure is a function that remembers variables from its outer scope.

---

## Example

```js
function counter() {
  let count = 0;

  return function () {
    count++;
    console.log(count);
  };
}

const inc = counter();

inc();
inc();
```

Output:

```txt
1
2
```

---

# Why does `count` survive?

Because the inner function keeps a reference to the outer lexical environment.

---

# Closure Mental Model

```txt
Function
+
Lexical Environment
```

---

# 6. Stack vs Heap

## Stack

Stores:

- execution contexts
- primitive values
- references

Fast and ordered.

---

## Heap

Stores:

- objects
- arrays
- functions
- closures

Dynamic memory allocation.

---

## Example

```js
const a = { x: 1 };
const b = a;

b.x = 2;
```

Both variables reference the same heap object.

---

# 7. Garbage Collection

JavaScript automatically frees unused memory.

Main algorithm:

# Mark and Sweep

---

## Mark Phase

Engine marks everything reachable from:

- global scope
- active stack
- closures

---

## Sweep Phase

Everything unreachable is removed from memory.

---

## Example

```js
let user = {
  name: "Dan",
};

user = null;
```

The object becomes unreachable and may be collected.

---

# Important

GC is NOT immediate.

The engine decides when cleanup happens.

---

# 8. Memory Leaks

Memory leak =
objects remain reachable even though they are no longer needed.

---

# Common Causes

## 1. Global References

```js
const data = [];

function add() {
  data.push(new Array(1000000));
}
```

---

## 2. Event Listeners

```js
button.addEventListener("click", () => {
  console.log("clicked");
});
```

Listeners may keep DOM nodes alive.

---

## 3. Closures

```js
function huge() {
  const big = new Array(1000000);

  return function () {
    console.log(big.length);
  };
}
```

`big` remains alive through closure references.

---

# 9. Event Loop

JavaScript is single-threaded.

The Event Loop coordinates:

- synchronous execution
- async callbacks
- rendering

---

# High-Level Flow

```txt
Run JS
↓
Microtasks
↓
Render
↓
Macrotask
```

---

# 10. Microtasks vs Macrotasks

## Microtasks

Higher priority queue.

Examples:

- Promise callbacks
- `queueMicrotask`
- async/await continuations

---

## Macrotasks

Lower priority.

Examples:

- `setTimeout`
- `setInterval`
- DOM events

---

## Example

```js
console.log(1);

setTimeout(() => {
  console.log(2);
}, 0);

Promise.resolve().then(() => {
  console.log(3);
});

console.log(4);
```

Output:

```txt
1
4
3
2
```

---

# Why?

Because:

- synchronous code runs first
- microtasks drain before macrotasks

---

# 11. Rendering Pipeline

Browser rendering happens between tasks.

---

# Simplified Pipeline

```txt
JS Execution
↓
Style Calculation
↓
Layout
↓
Paint
↓
Composite
```

---

# Important

Rendering cannot happen while JS blocks the main thread.

---

## Example

```js
document.body.style.background = "red";

while (true) {}
```

DOM changed,
but render never occurs.

---

# Render Starvation

Infinite microtasks can block rendering:

```js
function spam() {
  queueMicrotask(spam);
}

spam();
```

---

# 12. Lazy Parsing & Lazy Compilation

JavaScript engines do not fully parse every function immediately.

Unused functions may be lazily parsed and compiled.

---

# Why?

Performance optimization.

---

## Example

```js
function app() {}

function hugeFeature() {
  // massive code
}
```

`hugeFeature` may remain lazily compiled until first execution.

---

# Runtime Flow

```txt
Function called
↓
Engine notices lazy function
↓
Parse
↓
Compile
↓
Execute
```

---

# Important

Lazy compilation is NOT part of the Event Loop.

It belongs to:

- parsing
- compilation
- optimization pipeline

---

# 13. Async/Await Internals

`async/await` is syntax sugar over Promises.

---

# async Always Returns a Promise

```js
async function test() {
  return 5;
}
```

Equivalent conceptually to:

```js
function test() {
  return Promise.resolve(5);
}
```

---

# await Mechanics

```js
async function test() {
  console.log(1);

  await Promise.resolve();

  console.log(2);
}

console.log(3);

test();

console.log(4);
```

Output:

```txt
3
1
4
2
```

---

# Why?

`await`:

- pauses the async function
- schedules continuation as a microtask

---

# Mental Model

```txt
await
=
pause function
+
enqueue continuation microtask
```

---

# await Does NOT Block the Thread

Important distinction:

```txt
await pauses the function,
not JavaScript itself
```

---

# Async State Machine

Engines internally transform async functions into continuation-based state machines.

---

# Example Conceptually

```js
async function run() {
  await a();
  await b();
}
```

Becomes conceptually:

```js
function run() {
  return a().then(() => {
    return b();
  });
}
```

---

# Every await Creates a Yield Point

```txt
shared state may change
while the function is paused
```

This directly leads to race conditions.

---

# 14. Race Conditions

A race condition occurs when:

- multiple async operations
- modify shared state
- with unpredictable ordering

---

## Example

```js
let value = 0;

async function increase() {
  const current = value;

  await Promise.resolve();

  value = current + 1;
}

increase();
increase();
```

Expected:

```txt
2
```

Possible actual result:

```txt
1
```

---

# Why?

Both functions read:

```txt
value = 0
```

before either writes back.

---

# Important

Race conditions exist even in single-threaded JavaScript.

Because async scheduling creates non-deterministic timing.

---

# Senior-Level Insight

```txt
Every await introduces the possibility
that shared state changed before resuming.
```

---

# Common Solutions

## 1. AbortController

Cancel stale async operations.

---

## 2. Request IDs

Ignore outdated responses.

---

## 3. Locks / Mutexes

Prevent concurrent mutations.

---

## 4. Immutable State

Reduce shared mutable data.

---

# 15. Senior-Level Mental Models

---

# Event Loop

```txt
JavaScript executes tasks.
The Event Loop schedules continuations.
```

---

# Closures

```txt
Closures keep lexical environments alive.
```

---

# GC

```txt
Reachable memory survives.
Unreachable memory gets collected.
```

---

# async/await

```txt
await pauses execution,
not the thread.
```

---

# Rendering

```txt
Rendering only occurs
when the main thread is free.
```

---

# Performance

```txt
Long tasks block:
- rendering
- user input
- timers
- responsiveness
```

---

# Senior JavaScript Understanding

Senior-level understanding is not memorizing APIs.

It is understanding:

- execution flow
- scheduling
- memory
- rendering
- async coordination
- runtime behavior
- performance implications
- engine mental models
