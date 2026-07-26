# Security Policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for a security vulnerability.

Report it through [Radware Support](https://support.radware.com) or to your
Radware contact, and we will coordinate the fix and disclosure.

## Handling configuration data

This tool reads F5 BIG-IP configurations, which routinely contain sensitive
material: management and self IP addresses, hostnames, SNMP communities,
monitor credentials, certificate and key file references, and - inside `.ucs`
archives - private keys.

- The tool runs entirely **locally**. It never uploads, transmits, or phones
  home with any part of your configuration.
- It reads only the configuration files it needs (`config/bigip.conf`,
  `config/bigip_base.conf`) out of an archive; nothing else is extracted.
- Output is written only where you point it.

When sharing configurations in a **public GitHub issue**, sanitize them first,
or send them privately through a Radware support case instead. See
[CONTRIBUTING.md](CONTRIBUTING.md) for details.
