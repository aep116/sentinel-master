import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectSpike } from './monitor.js'

function makeResults(upCount, downCount) {
  return [
    ...Array(upCount).fill({ status: 'up' }),
    ...Array(downCount).fill({ status: 'down' }),
  ]
}

// --- Spike detection ---

test('no failures: no spike', () => {
  assert.equal(detectSpike(makeResults(500, 0)), false)
})

test('1 company down out of 500 (0.2%): no spike', () => {
  assert.equal(detectSpike(makeResults(499, 1)), false)
})

test('typical bad day: 9 down out of 500 (1.8%): no spike', () => {
  assert.equal(detectSpike(makeResults(491, 9)), false)
})

test('genuine AWS outage: 30 down out of 500 (6%): no spike', () => {
  assert.equal(detectSpike(makeResults(470, 30)), false)
})

test('large CDN outage: 80 down out of 500 (16%): no spike', () => {
  assert.equal(detectSpike(makeResults(420, 80)), false)
})

test('exactly at threshold: 100 down out of 500 (20%): spike', () => {
  assert.equal(detectSpike(makeResults(400, 100)), true)
})

test('above threshold: 150 down out of 500 (30%): spike', () => {
  assert.equal(detectSpike(makeResults(350, 150)), true)
})

test('half failing (50%): spike', () => {
  assert.equal(detectSpike(makeResults(250, 250)), true)
})

test('all failing (100%) — CF Worker down: spike', () => {
  assert.equal(detectSpike(makeResults(0, 500)), true)
})

// --- Edge cases ---

test('empty results: no spike', () => {
  assert.equal(detectSpike([]), false)
})

test('single company up: no spike', () => {
  assert.equal(detectSpike(makeResults(1, 0)), false)
})

test('single company down: spike (100%)', () => {
  assert.equal(detectSpike(makeResults(0, 1)), true)
})

test('custom threshold: 10 down out of 100 at 0.10 threshold: spike', () => {
  assert.equal(detectSpike(makeResults(90, 10), 0.10), true)
})

test('custom threshold: 9 down out of 100 at 0.10 threshold: no spike', () => {
  assert.equal(detectSpike(makeResults(91, 9), 0.10), false)
})

// --- Regression: normal alert path unaffected ---

test('regression: normal run with 5 down stays below spike threshold', () => {
  const results = makeResults(495, 5)
  assert.equal(detectSpike(results), false)
  // Verify the down results are still present for alert processing
  const downResults = results.filter(r => r.status === 'down')
  assert.equal(downResults.length, 5)
})

test('regression: all up run returns correct counts', () => {
  const results = makeResults(508, 0)
  assert.equal(detectSpike(results), false)
  assert.equal(results.filter(r => r.status === 'up').length, 508)
  assert.equal(results.filter(r => r.status === 'down').length, 0)
})

test('regression: mixed results preserve status values', () => {
  const results = makeResults(490, 10)
  assert.equal(results.filter(r => r.status === 'up').length, 490)
  assert.equal(results.filter(r => r.status === 'down').length, 10)
  assert.equal(detectSpike(results), false)
})
