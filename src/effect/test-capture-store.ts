import type { TestCaptures } from './test-layers.js'

const responseCaptures = new WeakMap<Response, TestCaptures>()

export function setResponseTestCaptures(
  response: Response,
  captures: TestCaptures
): void {
  responseCaptures.set(response, captures)
}

export function getResponseTestCaptures(
  response: Response
): TestCaptures | undefined {
  return responseCaptures.get(response)
}
