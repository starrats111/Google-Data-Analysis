import json
from google import genai

class gemini_model:
    def __init__(self, gemini_apikey=None, gpt_apikey=None):
        self.gemini_client = genai.Client(api_key=gemini_apikey)
        self.prompt = json.load(open("prompt.json", "r", encoding="utf-8"))

    def gemini_talk(self, url, country, keyword, title, description):
        # keyword = self.gemini_client.models.generate_content(
        #     model="gemini-2.5-flash",
        #     contents=self.prompt['keyword'].replace("xxx.com", url),
        # )
        title_ = self.gemini_client.models.generate_content(
            model="gemini-2.5-flash",
            contents=self.prompt['title'].replace("{us}", country).replace("{xxx.com}", url).replace('{keyword}', ','.join(keyword)) + ','.join(title),
        )
        description_ = self.gemini_client.models.generate_content(
            model="gemini-2.5-flash",
            contents=self.prompt['description'].replace("{us}", country).replace("{xxx.com}", url).replace('{keyword}', ','.join(keyword)).replace('{title}',title_.text) + ','.join(description),
        )
        return title_.text, description_.text

if __name__ == '__main__':
    model = gemini_model("AIzaSyAM9N2qMKs5McxpZQdadKKEsgWWFui_N_4")
    print(model.gemini_talk("https://www.nike.com/"))
    print(model.gemini_talk("https://www.nike.com/"))