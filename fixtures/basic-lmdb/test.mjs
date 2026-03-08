import { answer } from 'mini-utils';
if (answer() !== 42) {
  throw new Error('mini-utils returned the wrong answer');
}
console.log('fixture test ok');
