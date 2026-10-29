// Copyright © 2023-2026 Cognizant Technology Solutions Corp, www.cognizant.com.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// END COPYRIGHT
/**
 * Interface contract for a coded tool to squelch the anti-pattern of
 * Static Cling.
 *
 * Upon activation by the agent hierarchy, a CodedTool will have either its
 * async_invoke() (preferred) or synchronous invoke() method called by the system.
 *
 * Implementations are expected to clean up after themselves.
 */
export interface CodedTool {
  /**
   * Called when the coded tool is invoked asynchronously by the agent hierarchy.
   * Strongly consider overriding this method instead of the "easier" synchronous
   * invoke() version above when the possibility of making any kind of call that could block
   * (like sleep() or a socket read/write out to a web service) is within the
   * scope of your CodedTool and can be done asynchronously, especially within
   * the context of your CodedTool running within a server.
   *
   * If you find your CodedTools can't help but synchronously block,
   * strongly consider looking into using the asyncio.to_thread() function
   * to not block the EventLoop for other requests.
   * See: https://docs.python.org/3/library/asyncio-task.html#asyncio.to_thread
   * async def async_invoke(this, args: Dict[str, Any], sly_data: Dict[str, Any]) -> Any:
   * return await asyncio.to_thread(this.invoke, args, sly_data)
   *
   * :param args: An argument dictionary whose keys are the parameters
   * to the coded tool and whose values are the values passed for them
   * by the calling agent.  This dictionary is to be treated as read-only.
   * :param sly_data: A dictionary whose keys are defined by the agent hierarchy,
   * but whose values are meant to be kept out of the chat stream.
   *
   * This dictionary is largely to be treated as read-only.
   * It is possible to add key/value pairs to this dict that do not
   * yet exist as a bulletin board, as long as the responsibility
   * for which coded_tool publishes new entries is well understood
   * by the agent chain implementation and the coded_tool implementation
   * adding the data is not invoke()-ed more than once.
   * :return: A return value that goes into the chat stream.
   */
  async_invoke(args: Record<string, any>, sly_data: Record<string, any>): Promise<any>;
}
