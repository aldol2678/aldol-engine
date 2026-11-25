// src/core/next/inventory.js — item stacks, atomic recipes and trades
// (ENGINE-NEXT-01 candidate).
//
// An inventory is plain JSON: { items: { [itemId]: count }, capacity }.
// capacity is the max total item count (null = unlimited). Counts are
// positive integers; an item at 0 is deleted so two inventories with the
// same contents always hash the same.
// Invariant: transfer() and trade() conserve the total number of each item
// across the two inventories, and every operation is all-or-nothing.
// Pure module.

function assertQty(qty) {
  if (!Number.isInteger(qty) || qty <= 0) throw new RangeError(`inventory: quantity must be a positive integer, got ${qty}`);
}
function assertItem(item) {
  if (typeof item !== "string" || item.length === 0 || item === "__proto__" || item === "constructor" || item === "prototype") {
    throw new RangeError(`inventory: bad item id ${String(item)}`);
  }
}
function assertBag(bag) {
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) throw new RangeError("inventory: item map must be an object");
  for (const item of Object.keys(bag)) { assertItem(item); assertQty(bag[item]); }
}

export function createInventory({ capacity = null, items = {} } = {}) {
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 0)) throw new RangeError("inventory: capacity must be null or a non-negative integer");
  const inv = { items: {}, capacity };
  assertBag(items);
  for (const item of Object.keys(items).sort()) {
    if (!add(inv, item, items[item])) throw new RangeError("inventory: initial items exceed capacity");
  }
  return inv;
}

export function count(inv, item) {
  return Object.prototype.hasOwnProperty.call(inv.items, item) ? inv.items[item] : 0;
}
export function total(inv) {
  let n = 0;
  for (const item of Object.keys(inv.items)) n += inv.items[item];
  return n;
}
export function freeSpace(inv) {
  return inv.capacity === null ? Infinity : inv.capacity - total(inv);
}
export function canAdd(inv, item, qty = 1) {
  assertItem(item); assertQty(qty);
  return freeSpace(inv) >= qty;
}
// All-or-nothing add. Returns true when the items were added.
export function add(inv, item, qty = 1) {
  if (!canAdd(inv, item, qty)) return false;
  inv.items[item] = count(inv, item) + qty;
  return true;
}
// All-or-nothing remove. Returns true when the items were removed.
export function remove(inv, item, qty = 1) {
  assertItem(item); assertQty(qty);
  const have = count(inv, item);
  if (have < qty) return false;
  if (have === qty) delete inv.items[item];
  else inv.items[item] = have - qty;
  return true;
}
export function hasAll(inv, bag) {
  assertBag(bag);
  return Object.keys(bag).every((item) => count(inv, item) >= bag[item]);
}
function bagTotal(bag) {
  let n = 0;
  for (const item of Object.keys(bag)) n += bag[item];
  return n;
}

// Move qty of one item between inventories. Conserves the item.
export function transfer(from, to, item, qty = 1) {
  assertItem(item); assertQty(qty);
  if (from === to) return false;
  if (count(from, item) < qty || !canAdd(to, item, qty)) return false;
  remove(from, item, qty);
  add(to, item, qty);
  return true;
}

// Recipe: consume `inputs` and produce `outputs` in one inventory.
export function craft(inv, inputs, outputs) {
  assertBag(inputs); assertBag(outputs);
  if (!hasAll(inv, inputs)) return false;
  if (freeSpace(inv) + bagTotal(inputs) < bagTotal(outputs)) return false;
  for (const item of Object.keys(inputs).sort()) remove(inv, item, inputs[item]);
  for (const item of Object.keys(outputs).sort()) add(inv, item, outputs[item]);
  return true;
}

// Two-sided exchange: a gives `give` to b and receives `take` from b.
// Either both sides move or nothing does.
export function trade(a, b, give, take) {
  assertBag(give); assertBag(take);
  if (a === b) return false;
  if (!hasAll(a, give) || !hasAll(b, take)) return false;
  if (freeSpace(a) + bagTotal(give) < bagTotal(take)) return false;
  if (freeSpace(b) + bagTotal(take) < bagTotal(give)) return false;
  for (const item of Object.keys(give).sort()) remove(a, item, give[item]);
  for (const item of Object.keys(take).sort()) remove(b, item, take[item]);
  for (const item of Object.keys(take).sort()) add(a, item, take[item]);
  for (const item of Object.keys(give).sort()) add(b, item, give[item]);
  return true;
}

export function isValidInventory(inv) {
  if (!inv || typeof inv !== "object" || !inv.items || typeof inv.items !== "object" || Array.isArray(inv.items)) return false;
  if (inv.capacity !== null && (!Number.isInteger(inv.capacity) || inv.capacity < 0)) return false;
  for (const item of Object.keys(inv.items)) {
    if (!Number.isInteger(inv.items[item]) || inv.items[item] <= 0) return false;
  }
  return inv.capacity === null || total(inv) <= inv.capacity;
}
