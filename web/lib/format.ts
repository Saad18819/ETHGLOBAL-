/// An address as 0x1234…abcd; anything else (a name like vitalik.eth) as it is.
export const shortAddress = (value: string) =>
  /^0x[0-9a-fA-F]{40}$/.test(value) ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
