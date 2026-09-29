// Real HTTP against an ephemeral Axum server with isolated stores, never native data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const fixture = JSON.parse(process.env.KRINE_ADDRESSING_FIXTURE);
assert.equal(new URL(fixture.url).hostname, "127.0.0.1");
let assertions = 0;
async function send(
  path,
  {
    method = "GET",
    body,
    key = randomUUID(),
    auth = "admin",
    status = 200,
  } = {},
) {
  const headers = { "content-type": "application/json" };
  if (auth === "admin")
    Object.assign(headers, {
      origin: fixture.origin,
      cookie: fixture.cookie,
      "x-csrf-token": fixture.csrf,
      "idempotency-key": key,
    });
  if (auth === "backend")
    headers.authorization = `Bearer ${fixture.serverSecret}`;
  if (auth === "browser")
    Object.assign(headers, {
      origin: fixture.browserOrigin,
      "x-krine-public-key": fixture.publicKey,
    });
  const response = await fetch(
    `${fixture.url}${auth === "admin" ? "/v1/admin" : "/v1"}${path}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const result = await response.json();
  assert.equal(
    response.status,
    status,
    `${method} ${path}: ${JSON.stringify(result)}`,
  );
  assertions++;
  return result;
}
const query = (values) => new URLSearchParams(values);
const check = (name, suffix = "") =>
  `/lookup/checks${suffix}?${query({ name })}`;
const relationship = (id, suffix = "") =>
  `/lookup/relationships${suffix}?${query({ kind: "backend", id })}`;
const policy = { schema_version: 1, inputs: {}, rules: [], otherwise: "DENY" };
const users = [
  ".",
  "..",
  "%2e",
  "%2E",
  "%2e%2e",
  ".%2e",
  "a/b?c#d&x=1+ 雪",
  "lookup",
];
const context = await send("/browser/context", {
  auth: "browser",
  method: "POST",
  body: {},
});
for (const [index, user] of users.entries()) {
  const id = index === 0 ? "." : index === 1 ? ".." : `association_${index}`;
  const envelope = {
    association_id: id,
    client_id: context.client_id,
    session_id: context.session_id,
    user_id: user,
  };
  const created = await send("/associations", {
    auth: "backend",
    method: "POST",
    body: envelope,
  });
  assert.equal(created.association_id, id);
  assert.equal(created.user_id, user);
  const entityPath = `/lookup/entities?${query({ kind: "user", id: user })}`;
  const entity = await send(entityPath);
  assert.equal(entity.id, user);
  const list = await send(
    `/lookup/entities/relationships?${query({ kind: "user", id: user, limit: "1" })}`,
  );
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, id);
  const source = await send(relationship(id));
  assert.equal(source.relationship.user_id, user);
  const correction = {
    revision: 1,
    reason: "Review owned addressability fixture",
  };
  const key = randomUUID();
  const corrected = await send(relationship(id, "/corrections"), {
    method: "POST",
    key,
    body: correction,
  });
  assert.equal(corrected.relationship.revision, 2);
  assert.deepEqual(
    await send(relationship(id, "/corrections"), {
      method: "POST",
      key,
      body: correction,
    }),
    corrected,
  );
  if (id !== "." && id !== "..") {
    assert.deepEqual(
      await send(`/relationships/backend/${id}/corrections`, {
        method: "POST",
        key,
        body: correction,
      }),
      corrected,
    );
    const restoreKey = randomUUID();
    const body = { revision: 2, reason: "Restore reviewed fixture" };
    const restored = await send(`/relationships/backend/${id}/restorations`, {
      method: "POST",
      key: restoreKey,
      body,
    });
    assert.deepEqual(
      await send(relationship(id, "/restorations"), {
        method: "POST",
        key: restoreKey,
        body,
      }),
      restored,
    );
  } else {
    assert.equal(
      (
        await send(relationship(id, "/restorations"), {
          method: "POST",
          body: { revision: 2, reason: "Restore reviewed fixture" },
        })
      ).relationship.revision,
      3,
    );
  }
  assert.equal(
    (await send(`${relationship(id)}&limit=1`)).audit.items.length,
    1,
  );
}
for (const name of [".", "..", "lookup", "ordinary"]) {
  await send("/checks", { method: "POST", body: { name } });
  assert.equal((await send(check(name))).name, name);
  const key = randomUUID();
  const body = { revision: 1, description: `Review ${name}`, policy };
  const saved = await send(check(name, "/draft"), { method: "PUT", key, body });
  assert.equal(saved.draft_revision, 2);
  if (name === "ordinary" || name === "lookup") {
    assert.deepEqual(
      await send(`/checks/${name}/draft`, { method: "PUT", key, body }),
      saved,
    );
  }
  const publicationKey = randomUUID();
  const publication = { revision: 2, expected_active_version: null };
  const published = await send(
    name === "ordinary"
      ? `/checks/${name}/publications`
      : check(name, "/publications"),
    { method: "POST", key: publicationKey, body: publication },
  );
  assert.deepEqual(
    await send(check(name, "/publications"), {
      method: "POST",
      key: publicationKey,
      body: publication,
    }),
    published,
  );
  assert.equal((await send(check(name, "/versions/1"))).version, 1);
  assert.equal(
    (await send(`${check(name, "/versions")}&limit=1`)).items[0].version,
    1,
  );
  const restorationKey = randomUUID();
  const restoration = { revision: 2, version: 1, replace_draft: true };
  const restored = await send(check(name, "/restorations"), {
    method: "POST",
    key: restorationKey,
    body: restoration,
  });
  assert.equal(restored.name, name);
  if (name === "ordinary")
    assert.deepEqual(
      await send(`/checks/${name}/restorations`, {
        method: "POST",
        key: restorationKey,
        body: restoration,
      }),
      restored,
    );
  const other = name === "." ? ".." : ".";
  await send(check(other, "/draft"), { method: "PUT", key, body, status: 409 });
}
for (const id of [".", "..", "event_ordinary"]) {
  await send("/events", {
    auth: "backend",
    method: "POST",
    body: { event_id: id, name: "addressing", user_id: "%2e" },
  });
  let record;
  for (let attempt = 0; attempt < 80; attempt++) {
    const response = await fetch(
      `${fixture.url}/v1/admin/lookup/events?${query({ id })}`,
      { headers: { cookie: fixture.cookie } },
    );
    if (response.ok) {
      record = await response.json();
      break;
    }
    assert.equal(response.status, 404);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(record?.event_id, id);
  assert.equal(record.user_id, "%2e");
}
// Literal encoded-looking IDs stay literal; they are allowed user IDs but not check/event IDs.
assert.equal(
  (await send(`/lookup/entities?${query({ kind: "user", id: "%2e" })}`)).id,
  "%2e",
);
await send(check("%2e"), { status: 422 });
await send("/lookup/events?id=%252e", { status: 422 });
for (const path of [
  "/lookup/checks?name=.&name=..",
  "/lookup/events?id=.&id=..",
  "/lookup/entities?kind=user&id=.&id=..",
  "/lookup/entities?kind=user&kind=client&id=.",
  "/lookup/entities/relationships?kind=user&id=.&id=..",
  "/lookup/relationships?kind=backend&id=.&id=..",
  "/lookup/relationships?kind=backend&kind=observed_ip&id=.",
])
  await send(path, { status: 422 });
await send("/lookup/relationships/corrections?kind=backend&id=.&id=..", {
  method: "POST",
  body: { revision: 3, reason: "Must not be applied" },
  status: 422,
});
await send("/lookup/checks/draft?name=.&name=..", {
  method: "PUT",
  body: { revision: 3, description: "Must not be applied", policy },
  status: 422,
});
assert.equal((await send(relationship("."))).relationship.revision, 3);
assert.equal((await send(check("."))).draft_revision, 3);
const shared = randomUUID();
const body = { revision: 3, reason: "Logical target identity" };
await send(relationship(".", "/corrections"), {
  method: "POST",
  key: shared,
  body,
});
await send(relationship("..", "/corrections"), {
  method: "POST",
  key: shared,
  body,
  status: 409,
});
assert.equal((await send(relationship(".."))).relationship.revision, 3);
console.log(
  `addressing HTTP checks passed (${assertions} responses plus exact identity assertions)`,
);
