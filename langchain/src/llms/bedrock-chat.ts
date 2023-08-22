import { SignatureV4 } from "@aws-sdk/signature-v4";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@aws-sdk/protocol-http";
import { EventStreamMarshaller } from "@aws-sdk/eventstream-marshaller";
import { fromUtf8, toUtf8 } from "@aws-sdk/util-utf8-universal";
import { Sha256 } from "@aws-crypto/sha256-js";
import type { AwsCredentialIdentity, Provider } from "@aws-sdk/types";
import { getEnvironmentVariable } from "../util/env.js";
import { LLM, BaseLLMParams } from "./base.js";
import { CallbackManagerForLLMRun } from "../callbacks/manager.js";

type Dict = { [key: string]: unknown };
type CredentialType = AwsCredentialIdentity | Provider<AwsCredentialIdentity>;

class BedrockChatLLMInputOutputAdapter {
  /** Adapter class to prepare the inputs from Langchain to a format
  that LLM model expects. Also, provides a helper function to extract
  the generated text from the model response. */

  static prepareInput(provider: string, prompt: string): Dict {
    const inputBody: Dict = {};

    if (provider === "anthropic" || provider === "ai21") {
      inputBody.prompt = prompt;
    } else if (provider === "amazon") {
      inputBody.inputText = prompt;
      inputBody.textGenerationConfig = {};
    } else {
      inputBody.inputText = prompt;
    }

    if (provider === "anthropic" && !("max_tokens_to_sample" in inputBody)) {
      inputBody.max_tokens_to_sample = 50;
    }

    return inputBody;
  }

  static prepareOutput(
    provider: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    responseBody: any,
    streaming: boolean
  ): string {
    if (streaming) {
      if (provider === "anthropic") {
        return responseBody.completion;
      } else if (provider === "ai21") {
        return responseBody.data.text;
      }
      return responseBody.outputText;
    } else {
      if (provider === "anthropic") {
        return responseBody.completion;
      } else if (provider === "ai21") {
        return responseBody.completions[0].data.text;
      }
      return responseBody.results[0].outputText;
    }
  }
}

/** Bedrock models.
    To authenticate, the AWS client uses the following methods to automatically load credentials:
    https://boto3.amazonaws.com/v1/documentation/api/latest/guide/credentials.html
    If a specific credential profile should be used, you must pass the name of the profile from the ~/.aws/credentials file that is to be used.
    Make sure the credentials / roles used have the required policies to access the Bedrock service.
*/
export interface BedrockInput {
  /** Model to use.
      For example, "amazon.titan-tg1-large", this is equivalent to the modelId property in the list-foundation-models api.
  */
  model: string;

  /** The AWS region e.g. `us-west-2`.
      Fallback to AWS_DEFAULT_REGION env variable or region specified in ~/.aws/config in case it is not provided here.
  */
  region?: string;

  /** AWS Credentials.
      If no credentials are provided, the default credentials from `@aws-sdk/credential-provider-node` will be used.
   */
  credentials?: CredentialType;

  /** Temperature */
  temperature?: number;

  /** Max tokens */
  maxTokens?: number;

  /** Streaming */
  streaming?: boolean;

  /** A custom fetch function for low-level access to AWS API. Defaults to fetch() */
  fetchFn?: typeof fetch;
}

export class BedrockChat extends LLM implements BedrockInput {
  model = "amazon.titan-tg1-large";

  region: string;

  credentials: CredentialType;

  temperature?: number | undefined = undefined;

  maxTokens?: number | undefined = undefined;

  streaming?: boolean | undefined = false;

  fetchFn: typeof fetch;

  marshaller: EventStreamMarshaller = new EventStreamMarshaller(
    toUtf8,
    fromUtf8
  );

  get lc_secrets(): { [key: string]: string } | undefined {
    return {};
  }

  _llmType() {
    return "bedrock";
  }

  constructor(fields?: Partial<BedrockInput> & BaseLLMParams) {
    super(fields ?? {});

    this.model = fields?.model ?? this.model;
    const allowedModels = ["ai21", "anthropic", "amazon"];
    if (!allowedModels.includes(this.model.split(".")[0])) {
      throw new Error(
        `Unknown model: '${this.model}', only these are supported: ${allowedModels}`
      );
    }
    const region =
      fields?.region ?? getEnvironmentVariable("AWS_DEFAULT_REGION");
    if (!region) {
      throw new Error(
        "Please set the AWS_DEFAULT_REGION environment variable or pass it to the constructor as the region field."
      );
    }
    this.region = region;
    this.credentials = fields?.credentials ?? defaultProvider();
    this.temperature = fields?.temperature ?? this.temperature;
    this.maxTokens = fields?.maxTokens ?? this.maxTokens;
    this.streaming = fields?.streaming ?? this.streaming;
    this.fetchFn = fields?.fetchFn ?? fetch;
  }

  /** Call out to Bedrock service model.
    Arguments:
      prompt: The prompt to pass into the model.

    Returns:
      The string generated by the model.

    Example:
      response = model.call("Tell me a joke.")
  */
  async _call(
    prompt: string,
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<string> {
    const provider = this.model.split(".")[0];
    const service = "bedrock";

    const inputBody = BedrockChatLLMInputOutputAdapter.prepareInput(
      provider,
      prompt
    );

    const url = this.streaming
      ? new URL(
          `https://${service}.${this.region}.amazonaws.com/model/${this.model}/invoke-with-response-stream`
        )
      : new URL(
          `https://${service}.${this.region}.amazonaws.com/model/${this.model}/invoke`
        );

    const request = new HttpRequest({
      hostname: url.hostname,
      path: url.pathname,
      protocol: url.protocol,
      method: "POST", // method must be uppercase
      body: JSON.stringify(inputBody),
      query: Object.fromEntries(url.searchParams.entries()),
      headers: {
        // host is required by AWS Signature V4: https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
        host: url.host,
        accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    const signer = new SignatureV4({
      credentials: this.credentials,
      service,
      region: this.region,
      sha256: Sha256,
    });

    const signedRequest = (await signer.sign(request)) as HttpRequest;
    const response = await this.fetchFn(url, {
      headers: signedRequest.headers,
      body: signedRequest.body,
      method: signedRequest.method,
    });
    if (response.status < 200 || response.status >= 300) {
      throw Error(
        `Failed to access underlying url '${url}': got ${response.status} ${
          response.statusText
        }: ${await response.text()}`
      );
    }

    if (this.streaming) {
      const chunks: string[] = [];
      const reader = response.body?.getReader();
      for await (const chunk of this._readChunks(reader)) {
        const event = this.marshaller.unmarshall(chunk);
        if (
          event.headers[":event-type"].value !== "chunk" ||
          event.headers[":content-type"].value !== "application/json"
        ) {
          throw Error(`Failed to get event chunk: got ${chunk}`);
        }
        const body = JSON.parse(
          Buffer.from(
            JSON.parse(new TextDecoder("utf-8").decode(event.body)).bytes,
            "base64"
          ).toString()
        );
        const text = BedrockChatLLMInputOutputAdapter.prepareOutput(
          provider,
          body,
          true
        );
        await runManager?.handleLLMNewToken(text);
        chunks.push(text);
      }
      return chunks.join("");
    } else {
      const responseJson = await response.json();

      return BedrockChatLLMInputOutputAdapter.prepareOutput(
        provider,
        responseJson,
        false
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _readChunks(reader: any) {
    return {
      async *[Symbol.asyncIterator]() {
        let readResult = await reader.read();
        while (!readResult.done) {
          yield readResult.value;
          readResult = await reader.read();
        }
      },
    };
  }
}
