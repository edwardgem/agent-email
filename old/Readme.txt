8/18/2025
V1 - Claude generated, all in one file.

V2 - Claude changed to separate .sh and inquiryon.conf. The HTML is in the .conf file.

8/19/2025
V3 - GPT-5 mini
   - Separated the request specification into a new text file inquiryon_request.conf, moved the Email list from inquiryon.conf into the new conf.
   - The .sh will read the request (in English) from inquiryon_request.conf and generate the HTML file.
   - But the .sh file now don't use LLM at all.

