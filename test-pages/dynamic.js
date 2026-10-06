document.getElementById("addDynamicButton").addEventListener("click", () => {
  const link = document.createElement("a");
  link.href = "sample-files/dynamic-file.json";
  link.textContent = "Dynamically added JSON file";
  document.getElementById("dynamicTarget").replaceChildren(link);
});
