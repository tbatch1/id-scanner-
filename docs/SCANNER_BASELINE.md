# Scanner Baseline (Do Not Lose This)

This project’s **known-good iPad barcode capture + verify flow** lives in:

- `frontend/payment-gateway-stable.html`

Baseline reference:

- Commit: `aabe2c08929db85dd47a14d9e3591ff8ee8d5927`
- Production route: `/payment-gateway-stable.html`

## Restore just the scanner file

If an AI or a bad merge breaks scanning, restore the baseline file only:

```bash
git checkout aabe2c08929db85dd47a14d9e3591ff8ee8d5927 -- frontend/payment-gateway-stable.html
```

Then redeploy.

