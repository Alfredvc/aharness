- We need some way of specifying fully autonomous mode. One of the reasons is to make sure that no user interacitons are triggered. We should be able to guarantee this statically before starting. For example we can enforce no open states, no away, no ask user questions etc. The missing piece here is permissions. how can we handle those?

- Need a good way to handle permissions, also for autonomous runs. Can we reject all permission requets in autonomous mode?

- We need to fix the cli output. No reason to print that the verifier is OK. Just print warnings / errors if available. Also dont print model messages. We should just print the url.

- Some edges from collapsed embedded FSMs are visible even when the embedded FSM is collapsed.

- We need to fix multiple bugs in the ui.
  1.  when clicking on previous states some display "no activity yet in this visit" Which is wrong, there has been activity but it is not being displayed.
  2.  Only current visit information is shown. I can see "visit 2 · via submit from executeSlice" but nothing above it.
  3.  The turns counter at the top should be removed.
  4.  Users should be able to see more info for each mode message / tool call. At least the model name, effort, and context size at submission time.
  5.  We should display aggregate information at the top. Things like: runnning time, total tokens used.
