import { NodeProp } from "@lezer/common"

/** Offsets relative to a top-level block, including its boundary lookahead. */
export interface BlockInfo {
  owner: object
  from: number
  to: number
  lookAhead: number
  atStart: boolean
}

export const blockInfo = new NodeProp<BlockInfo>({ perNode: true })
export const parserOwner = new NodeProp<object>({ perNode: true })
