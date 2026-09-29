import type { ExecutionContext } from "../../core/types.ts";

import { afterEach, expect, it, vi } from "vitest";
import { validateActionInput } from "../../core/validation.ts";
import { weixinStoreActions } from "./actions.ts";
import { executors } from "./executors.ts";

afterEach(() => vi.unstubAllGlobals());

it("uses the new category protocol, sends string ids as numbers, and rejects string-valued WeChat errors", async () => {
  // list_categories and get_category return numeric ids as strings, so callers pass them through as-is.
  const categoryInfo = {
    cats_v2: [{ cat_id: "10" }, { cat_id: 20 }],
    license_group_list: [
      {
        license_group_id: "9",
        license: { license_id: "11", file_id_list: ["file-1"], license_field_list: [{ key: "no", value: "A1" }] },
      },
    ],
    brand_list: [{ brand_id: "10000031" }],
    baobeihan: ["file-2"],
  };

  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push(new Request(url, init));
    return Response.json(
      requests.length === 1
        ? { access_token: "token", expires_in: 7200 }
        : requests.length === 2
          ? { errcode: 0, audit_id: 42 }
          : { errcode: "10020094", errmsg: "qualification file required" },
    );
  });
  const context: ExecutionContext = {
    async getCredential() {
      return {
        authType: "custom_credential",
        values: { appId: "category-test-app", appSecret: "secret" },
        profile: { accountId: "category-test-app", displayName: "Test store", grantedScopes: [] },
        metadata: {},
      };
    },
  };

  const action = weixinStoreActions.find((candidate) => candidate.name === "apply_category")!;
  expect(validateActionInput(action, { categoryInfo }).valid).toBe(true);

  const result = await executors["weixin_store.apply_category"]!({ categoryInfo }, context);
  expect(result).toEqual({ ok: true, output: { audit_id: 42 } });
  expect(new URL(requests[1]!.url).pathname).toBe("/channels/ec/category/add");
  expect(await requests[1]!.json()).toEqual({
    category_info: {
      cats_v2: [{ cat_id: 10 }, { cat_id: 20 }],
      license_group_list: [
        {
          license_group_id: 9,
          license: { license_id: 11, file_id_list: ["file-1"], license_field_list: [{ key: "no", value: "A1" }] },
        },
      ],
      brand_list: [{ brand_id: 10000031 }],
      baobeihan: ["file-2"],
      is_new_apply_cat: true,
    },
  });

  const failure = await executors["weixin_store.apply_category"]!({ categoryInfo }, context);
  expect(failure).toMatchObject({
    ok: false,
    error: { code: "invalid_input", message: "WeChat API error 10020094: qualification file required" },
  });
});

it("rejects oversized qualification images before contacting WeChat", async () => {
  const file = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "qualification.png", { type: "image/png" });
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const context: ExecutionContext = {
    async getCredential() {
      return {
        authType: "custom_credential",
        values: { appId: "category-size-test-app", appSecret: "secret" },
        profile: { accountId: "category-size-test-app", displayName: "Test store", grantedScopes: [] },
        metadata: {},
      };
    },
    transitFiles: {
      maxBytes: 100 * 1024 * 1024,
      async create() {
        throw new Error("not used");
      },
      async read() {
        return { file, sizeBytes: file.size, name: file.name, mimeType: file.type };
      },
      async delete() {
        return false;
      },
    },
  };

  const result = await executors["weixin_store.upload_qualification_image"]!(
    { file: { fileId: "oversized" } },
    context,
  );
  expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(fetcher).not.toHaveBeenCalled();
});
