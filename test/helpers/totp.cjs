const speakeasy = require('speakeasy');

function totpAtStep(secret, step) {
  return speakeasy.totp({ secret, encoding: 'base32', time: step * 30 });
}

async function currentTotpStep() {
  // A previous-step setup code would legitimately expire during a boundary crossing.
  const remaining = 30_000 - (Date.now() % 30_000);
  if (remaining < 2_000) {
    await new Promise((resolve) => setTimeout(resolve, remaining + 100));
  }
  return Math.floor(Date.now() / 30_000);
}

module.exports = { currentTotpStep, totpAtStep };
