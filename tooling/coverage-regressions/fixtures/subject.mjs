export function choose(flag) {
  if (flag === 'never') {
    return 'unexecuted branch';
  }
  if (flag) {
    return 'chosen';
  }
  return 'other';
}

export function untouched() {
  return 'unexecuted';
}

export function makeNested() {
  function nestedUntouched() {
    return 'also unexecuted';
  }
  return nestedUntouched;
}
