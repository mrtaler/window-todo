import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addDays, dueColor, dueState, earliestDue, isIsoDay, localDay, parseDue, shortDue } from './due'

const TODAY = '2026-11-12'
const dueOf = (raw: string, today = TODAY): string => {
  const read = parseDue(raw, today)
  if ('error' in read) throw new Error(read.error)

  return read.due
}

test('a day is read from every written form', () => {
  assert.equal(dueOf('2026-12-01'), '2026-12-01')
  assert.equal(dueOf('today'), TODAY)
  assert.equal(dueOf('Tomorrow'), '2026-11-13')
  assert.equal(dueOf('+3d'), '2026-11-15')
  assert.equal(dueOf('+0d'), TODAY)
  assert.equal(dueOf('+30d'), '2026-12-12')
  assert.equal(dueOf(' 11-15 '), '2026-11-15')
  assert.equal(dueOf('1-5'), '2027-01-05')
})

test('a month and day already passed this year fall in the next year; today stays today', () => {
  assert.equal(dueOf('11-12'), '2026-11-12')
  assert.equal(dueOf('11-11'), '2027-11-11')
  assert.equal(dueOf('02-29'), '2028-02-29')
  assert.equal(dueOf('02-29', '2028-03-01'), '2032-02-29')
})

test('relative days cross month and year ends', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2028-02-28', 1), '2028-02-29')
  assert.equal(dueOf('tomorrow', '2026-12-31'), '2027-01-01')
})

test('anything else is refused with the forms it takes', () => {
  for (const raw of ['', 'soon', '2026-02-30', '2026-13-01', '13-01', '+5', '+99999d', '26-11-15', '11/15']) {
    const read = parseDue(raw, TODAY)
    assert.ok('error' in read, raw)
    assert.match('error' in read ? read.error : '', /YYYY-MM-DD, MM-DD, today, tomorrow or \+Nd/)
  }
  assert.equal(isIsoDay('2026-02-28'), true)
  assert.equal(isIsoDay('2026-2-28'), false)
  assert.equal(isIsoDay(20261112), false)
})

test('a day stands overdue, today or later, coloured red, yellow or not at all', () => {
  assert.equal(dueState('2026-11-11', TODAY), 'overdue')
  assert.equal(dueState(TODAY, TODAY), 'today')
  assert.equal(dueState('2026-11-13', TODAY), 'later')
  assert.equal(dueColor('overdue'), 'red')
  assert.equal(dueColor('today'), 'yellow')
  assert.equal(dueColor('later'), undefined)
})

test('a row shows the month and day within the year and the whole date beyond it', () => {
  assert.equal(shortDue('2026-11-15', TODAY), '11-15')
  assert.equal(shortDue('2027-01-05', TODAY), '2027-01-05')
  assert.equal(earliestDue([undefined, '2026-12-01', '2026-11-20']), '2026-11-20')
  assert.equal(earliestDue([undefined]), undefined)
})

test('the local day is the calendar date of the clock reading', () => {
  const noon = new Date(2026, 10, 12, 12, 0, 0).getTime()
  assert.equal(localDay(noon), '2026-11-12')
})
