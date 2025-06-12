export function roundToNextMinute(date: Date) {
  // Create a new date object to avoid modifying the original one
  const roundedDate = new Date(date);

  // Check if the seconds are greater than 0, if so, round up
  if (roundedDate.getSeconds() > 0 || roundedDate.getMilliseconds() > 0) {
    // Add one minute
    roundedDate.setMinutes(roundedDate.getMinutes() + 1);
  }

  // Set seconds and milliseconds to 0
  roundedDate.setSeconds(0);
  roundedDate.setMilliseconds(0);

  return roundedDate;
}
