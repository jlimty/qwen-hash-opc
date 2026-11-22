// A fresh, well-formed (fictional) Singapore UEN for each test company: nine digits and a letter.
let next = 100000000 + Math.floor(Math.random() * 800000000);
export const testUen = () => `${next++}K`;
