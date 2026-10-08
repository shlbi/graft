/** Operator CLI: four bounded Stripe GETs, no writes, no customer/payment data or secrets printed. */
import {checkBillingSetup} from '../remote/billing-setup.mjs';
if (process.argv.length !== 3 || process.argv[2] !== '--check') {
  console.error('Usage: node scripts/check-billing-setup.mjs --check');
  process.exitCode = 2;
} else {
  const report = await checkBillingSetup();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
