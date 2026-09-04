# Container-backed Durable Objects

This fixture verifies that the Vitest plugin builds the image declared in the
Worker configuration and exercises the attached container through the real
`ctx.container` runtime interface. A second project keeps the same container
declaration but sets `dev.enable_containers` to `false`, verifying that projects
which explicitly disable local containers do not require Docker.
