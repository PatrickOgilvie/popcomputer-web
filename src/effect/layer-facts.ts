/**
 * What the framework knows about a layer an application provides to routes,
 * recorded where the layer is made, so the route table can say who a route
 * lets in and whether a guard decides for it.
 */

import type { Layer } from 'effect'

/**
 * What a provided layer does before the action: a `guard(...)` decides,
 * `RequireAuthLayer` lets in signed-in visitors only, and `RequireGuestLayer`
 * or `createGuestLayer` sends signed-in ones away.
 */
export type LayerFact = 'guard' | 'signed-in' | 'guests'

/** A layer as routes are provided it. */
type ProvidedLayer = Layer.Layer<never, unknown, unknown>

const facts = new WeakMap<ProvidedLayer, LayerFact>()

/** Record what `layer` does, returning it. */
export function withLayerFact<L extends ProvidedLayer>(layer: L, fact: LayerFact): L {
  facts.set(layer, fact)

  return layer
}

/** What `layer` does, if the framework made it: a layer composed into another is not found. */
export const layerFactOf = (layer: ProvidedLayer): LayerFact | undefined => facts.get(layer)
