# Security

## Reporting a problem

If you find a security problem in this template, please report it privately: open the **Security** tab of this repository and click **Report a vulnerability**. Please do not open a public issue for it.

Include what you found, how to reproduce it, and what an attacker could do with it.

## What the template protects against

See [Security model](README.md#security-model) in the README for the checks the template runs and their limits. In short:

* The widget token and allowed origins stop other websites from embedding your bot, but not a determined person, because the token is visible in your page source.
* The prompt-injection check is a first filter for common attack phrases. The system prompt is the second layer. No filter stops every attack, so put only information you are happy to share in your profile.
* Set a monthly budget limit with your AI provider. The rate limits slow down abuse but are not a spending cap.
