import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 4 does not forward a rejected promise from an async handler to
 * the error middleware: the rejection stays unhandled and takes the whole
 * process down. Wrapping a handler routes that rejection through `next`
 * instead, so one bad request becomes one error response rather than a
 * crashed server.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
